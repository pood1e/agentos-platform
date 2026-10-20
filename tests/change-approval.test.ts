import assert from "node:assert/strict";
import { fromJson, toJsonString } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import { describe, expect, it } from "vitest";
import {
  ChangeBlocker,
  ChangeSchema,
  ChangeState,
} from "../gen/agentos/governance/v1/change_pb.js";
import { Zammad } from "../server/change-control/providers/zammad/api.js";
import { operationHash } from "../server/shared/change-digest.js";
import { changeFixture, database } from "./change-control-fixture.js";

describe.skipIf(!database)("native Zammad approval integrity", () => {
  const context = changeFixture();

  it("lets native platform management through without creating approvals and keeps device jobs protected", async () => {
    const { control, request, client } = context.setup();
    for (const name of [
      "netbox_dcim_devices_create",
      "jumpserver_assets_hosts_create",
      "jumpserver_accounts_accounts_partial_update",
      "keycloak_keycloak_user_role_assign",
    ]) {
      await expect(control.authorize("asset", name, { id: "asset" })).resolves.toBeUndefined();
    }
    expect(context.api.created()).toBe(0);
    await expect(
      control.authorize("asset", "jumpserver_ops_jobs_create", { run_after_save: true }),
    ).rejects.toThrow("approved change");
    await expect(control.authorize("asset", "jumpserver_unknown_tool", {})).rejects.toThrow(
      "Unknown environment tool",
    );
    assert(request.tool && request.preparation);
    request.tool.name = "lab-real-netbox_dcim_devices_create";
    request.preparation.operationHash = operationHash(request.tool.name, request.tool.args ?? {});
    await expect(client.registerChange({ request })).rejects.toThrow("without a work order");
    expect(context.api.created()).toBe(0);
  });

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
    expect(notes[0]?.body).toContain("Tool call failed");
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

  it("prefills the engineer's assessment and allows an audited approval without a comment", async () => {
    const { client, request } = context.setup();
    const { result } = await client.registerChange({ request });
    assert(result?.change);
    const id = Number(result.change.ticketId);
    context.api.decide(id, "approved", 3);
    const ticket = context.api.records.get(id);
    assert(ticket);
    expect(ticket.agentos_impact).toBe(request.preparation?.plan?.impact);
    expect(ticket.agentos_validation).toBe(request.preparation?.plan?.validation);
    expect(ticket.agentos_rollback).toBe(request.preparation?.plan?.rollback);
    expect(ticket.agentos_simulation).toBe(request.preparation?.simulationReport);
    ticket.agentos_reason = "";
    expect((await client.getChange({ id: result.change.id })).result?.change?.state).toBe(
      ChangeState.APPROVED,
    );
    ticket.agentos_validation = "";
    expect((await client.getChange({ id: result.change.id })).result?.change).toMatchObject({
      state: ChangeState.PENDING,
      blocker: ChangeBlocker.ASSESSMENT_REQUIRED,
    });
  });

  it("requires human approval for a complete plan without simulation", async () => {
    const { client, control, request } = context.setup();
    assert(request.preparation?.plan && request.tool?.args);
    request.preparation.plan.simulation = undefined;
    request.preparation.simulationReport = "";
    const { result } = await client.registerChange({ request });
    assert(result?.change);
    expect(result.change.state).toBe(ChangeState.PENDING);
    const execute = () =>
      control.authorize(
        "remediation",
        "kubernetes_resources_create_or_update",
        request.tool?.args ?? {},
      );
    await expect(execute()).rejects.toThrow("prepared and approved");
    context.api.decide(Number(result.change.ticketId), "approved", 3, "");
    await client.prepareExecution({ id: result.change.id });
    await expect(execute()).resolves.toBe(result.change.id);
  });

  it("requires an immutable full proposal and complete assessment", async () => {
    const { client, request } = context.setup();
    assert(request.tool);
    request.tool.args = { manifest: '<script>literal</script> & <tag attr="value">', count: 2 };
    assert(request.preparation);
    request.preparation.operationHash = operationHash(request.tool.name, request.tool.args);
    const { result } = await client.registerChange({ request });
    assert(result?.change);
    context.api.decide(Number(result.change.ticketId), "approved", 3);
    await expect(client.getChange({ id: result.change.id })).resolves.toBeDefined();
    const ticket = context.api.records.get(Number(result.change.ticketId));
    assert(ticket);
    ticket.agentos_proposal = ticket.agentos_proposal.replace('"count":2', '"count":3');
    await expect(client.getChange({ id: result.change.id })).rejects.toThrow("proposal differs");
  });

  it("ignores native no-op history and assessment updates saved with the approval", async () => {
    const { client, ready } = await context.approved(false);
    assert(ready.change);
    const id = Number(ready.change.ticketId);
    const history = context.api.histories.get(id);
    const ticket = context.api.records.get(id);
    assert(history && ticket);
    const decision = history.findLast((item) => item.attribute === "agentos_decision");
    assert(decision);
    history.push({
      id: history.length + 1,
      attribute: "agentos_validation",
      value_from: ticket.agentos_validation,
      value_to: ticket.agentos_validation,
      created_by_id: decision.created_by_id,
      created_at: new Date(Date.parse(decision.created_at) + 1000).toISOString(),
    });
    history.push({
      id: history.length + 1,
      attribute: "agentos_impact",
      value_from: "Draft impact",
      value_to: ticket.agentos_impact,
      created_by_id: decision.created_by_id,
      created_at: decision.created_at,
    });
    expect((await client.getChange({ id: ready.change.id })).result?.change?.state).toBe(
      ChangeState.APPROVED,
    );
    history.push({
      id: history.length + 1,
      attribute: "agentos_impact",
      value_from: ticket.agentos_impact,
      value_to: "Expanded scope",
      created_by_id: decision.created_by_id,
      created_at: new Date(Date.parse(decision.created_at) + 2000).toISOString(),
    });
    ticket.agentos_impact = "Expanded scope";
    expect((await client.getChange({ id: ready.change.id })).result?.change).toMatchObject({
      state: ChangeState.PENDING,
      blocker: ChangeBlocker.PLAN_CHANGED,
    });
  });

  it("rejects a prepared plan for different parameters before creating a ticket", async () => {
    const { client, request } = context.setup();
    assert(request.tool);
    request.tool.args = { namespace: "another-scope" };
    await expect(client.registerChange({ request })).rejects.toThrow(
      "differs from the proposed operation",
    );
    expect(context.api.created()).toBe(0);
  });

  it("keeps credentials out of work orders and public change responses while authorizing exact arguments", async () => {
    const { client, control, request } = context.setup();
    assert(request.tool && request.preparation);
    const secret = "qa-private-credential";
    request.tool.args = { ...request.tool.args, secret };
    request.prompt = `Original input includes ${secret}`;
    request.intent = `Use the provided credential ${secret} for this scoped verification`;
    request.preparation.operationHash = operationHash(request.tool.name, request.tool.args);
    const { result } = await client.registerChange({ request });
    assert(result?.change);
    const ticket = context.api.records.get(Number(result.change.ticketId));
    expect(JSON.stringify(ticket)).not.toContain(secret);
    expect(toJsonString(ChangeSchema, result.change)).not.toContain(secret);
    context.api.decide(Number(result.change.ticketId), "approved", 3, "");
    await client.prepareExecution({ id: result.change.id });
    await expect(
      control.authorize("remediation", "kubernetes_resources_create_or_update", request.tool.args),
    ).resolves.toBe(result.change.id);
  });
});
