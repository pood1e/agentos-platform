import assert from "node:assert/strict";
import { fromJson } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import { describe, expect, it } from "vitest";
import { ChangeState } from "../gen/agentos/governance/v1/change_pb.js";
import { Zammad } from "../server/change-control/providers/zammad/api.js";
import { changeFixture, database } from "./change-control-fixture.js";

describe.skipIf(!database)("native Zammad approval integrity", () => {
  const context = changeFixture();

  it("retries the persisted execution result without rewriting its outcome", async () => {
    const { control, client, request, ready } = await context.approved();
    assert(ready.change && request.tool?.args);
    await control.authorize(
      "remediation",
      "kubernetes_resources_create_or_update",
      request.tool.args,
    );
    context.api.failNextResult();
    await expect(
      client.recordResult({
        id: ready.change.id,
        failed: true,
        output: fromJson(ValueSchema, { error: "Operation failed" }),
      }),
    ).rejects.toThrow("503");
    await client.recordResult({
      id: ready.change.id,
      failed: false,
      output: fromJson(ValueSchema, { changed: true }),
    });
    const recorded = await context.store.get(ready.change.id);
    expect(recorded.failed).toBe(true);
    expect(recorded.output).toEqual({ error: "Operation failed" });
    const api = new Zammad(context.api.url, "coordinator");
    const notes = await api.articles(ready.change.ticketId);
    expect(notes[0]?.body).toContain("Failed");
    expect(notes[0]?.body).toContain("Operation failed");
  });

  it("requires preparation after approval and expires execution preparation independently", async () => {
    const { client, control, request, ready } = await context.approved(false);
    assert(ready.change && request.tool?.args);
    const execute = () =>
      control.authorize(
        "remediation",
        "kubernetes_resources_create_or_update",
        request.tool?.args ?? {},
      );
    await expect(execute()).rejects.toThrow("prepared and approved");
    await client.prepareExecution({ id: ready.change.id });
    await context.admin`UPDATE ${context.admin(context.schema)}.changes SET prepared_at = now() - interval '6 minutes'`;
    await expect(execute()).rejects.toThrow("prepared and approved");
    expect((await context.store.get(ready.change.id)).claimed_at).toBeNull();
  });

  it("serializes identical prepared operations without a client-side execution token", async () => {
    const first = await context.approved();
    assert(first.ready.change);
    const second = await context.approved(false);
    assert(second.ready.change && second.request.tool?.args);
    await expect(second.client.prepareExecution({ id: second.ready.change.id })).rejects.toThrow(
      "already prepared",
    );
    await first.control.authorize(
      "remediation",
      "kubernetes_resources_create_or_update",
      second.request.tool.args,
    );
    await expect(
      second.client.prepareExecution({ id: second.ready.change.id }),
    ).resolves.toBeDefined();
    await expect(
      second.control.authorize(
        "remediation",
        "kubernetes_resources_create_or_update",
        second.request.tool.args,
      ),
    ).resolves.toBe(second.ready.change.id);
  });

  it("uses the native audit actor rather than a caller-supplied validator field", async () => {
    const { client, ready } = await context.approved();
    assert(ready.change);
    const audit = context.api.histories
      .get(Number(ready.change.ticketId))
      ?.findLast((item) => item.attribute === "agentos_decision");
    assert(audit);
    audit.created_by_id = 1;
    await expect(client.getChange({ id: ready.change.id })).rejects.toThrow(
      "unauthorized identity",
    );
  });

  it("invalidates a changed plan until a fresh native approval is recorded", async () => {
    const { client, control, request, ready } = await context.approved();
    assert(ready.change && request.tool?.args);
    const api = new Zammad(context.api.url, "coordinator");
    await api.update(ready.change.ticketId, {
      agentos_rollback: "A different rollback procedure",
    });
    expect((await client.getChange({ id: ready.change.id })).result?.change?.state).toBe(
      ChangeState.PENDING,
    );
    await expect(client.prepareExecution({ id: ready.change.id })).rejects.toThrow(
      "approved change",
    );
    await expect(
      control.authorize("remediation", "kubernetes_resources_create_or_update", request.tool.args),
    ).rejects.toThrow("revoked or changed");
    await api.update(ready.change.ticketId, { agentos_decision: "pending" });
    context.api.decide(Number(ready.change.ticketId), "approved", 3);
    await client.prepareExecution({ id: ready.change.id });
    await expect(
      control.authorize("remediation", "kubernetes_resources_create_or_update", request.tool.args),
    ).resolves.toBe(ready.change.id);
  });

  it("requires complete assessment and a current approval reason", async () => {
    const { client, request } = context.setup();
    const { result } = await client.registerChange({ request });
    assert(result?.change);
    const id = Number(result.change.ticketId);
    context.api.decide(id, "approved", 3);
    const ticket = context.api.records.get(id);
    assert(ticket);
    ticket.agentos_validation = "";
    expect((await client.getChange({ id: result.change.id })).result?.change?.state).toBe(
      ChangeState.PENDING,
    );
    ticket.agentos_validation = "Read the result";
    ticket.agentos_reason = "";
    expect((await client.getChange({ id: result.change.id })).result?.change?.state).toBe(
      ChangeState.PENDING,
    );
  });

  it("requires an immutable full proposal and complete assessment", async () => {
    const { client, request } = context.setup();
    assert(request.tool);
    request.tool.args = { manifest: '<script>literal</script> & <tag attr="value">', count: 2 };
    const { result } = await client.registerChange({ request });
    assert(result?.change);
    context.api.decide(Number(result.change.ticketId), "approved", 3);
    await expect(client.getChange({ id: result.change.id })).resolves.toBeDefined();
    const ticket = context.api.records.get(Number(result.change.ticketId));
    assert(ticket);
    ticket.agentos_proposal = ticket.agentos_proposal.replace('"count":2', '"count":3');
    await expect(client.getChange({ id: result.change.id })).rejects.toThrow("proposal differs");
  });
});
