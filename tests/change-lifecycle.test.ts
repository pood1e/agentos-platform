import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { clone } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
  type ChangeRequest,
  ChangeRequestSchema,
  ChangeState,
} from "../gen/agentos/governance/v1/change_pb.js";
import { Zammad } from "../server/change-control/providers/zammad/api.js";
import { changeId, operationHash } from "../server/shared/change-digest.js";
import { changeFixture, database } from "./change-control-fixture.js";

function retry(source: ChangeRequest) {
  const request = clone(ChangeRequestSchema, source);
  assert(request.tool);
  request.taskId = randomUUID();
  request.requestId = randomUUID();
  request.tool.id = randomUUID();
  request.tool.callId = randomUUID();
  return request;
}

describe.skipIf(!database)("work-order lifetime and native task correlation", () => {
  const context = changeFixture();

  it("removes the old deadline while preserving a pending work order for later human approval", async () => {
    const { client, request } = context.setup();
    const { result } = await client.registerChange({ request });
    assert(result?.change);
    const { id, ticketId } = result.change;
    await context.admin`ALTER TABLE ${context.admin(context.schema)}.changes ADD COLUMN expires_at timestamptz`;
    await context.admin`UPDATE ${context.admin(context.schema)}.changes SET expires_at = now() - interval '2 days'`;
    await context.store.initialize();
    const columns = await context.admin`SELECT column_name FROM information_schema.columns
      WHERE table_schema = ${context.schema} AND table_name = 'changes' AND column_name = 'expires_at'`;
    expect(columns).toHaveLength(0);
    expect((await client.getChange({ id })).result?.change?.state).toBe(ChangeState.PENDING);
    context.api.decide(Number(ticketId), "approved", 3);
    expect((await client.getChange({ id })).result?.change?.state).toBe(ChangeState.APPROVED);
  });

  it("reuses the original human approval for an unchanged invocation in the same native session", async () => {
    const { client, request, control, ready } = await context.approved(false);
    assert(ready.change);
    await client.recordResult({ id: ready.change.id, failed: true });
    expect((await context.store.get(ready.change.id)).failed).toBeNull();
    expect((await client.getChange({ id: ready.change.id })).result?.change?.state).toBe(
      ChangeState.APPROVED,
    );
    const next = retry(request);
    next.intent = "Continue the same approved operation";
    const { result } = await client.registerChange({ request: next });
    expect(result?.change).toMatchObject({
      id: ready.change.id,
      ticketId: ready.change.ticketId,
      state: ChangeState.APPROVED,
      decidedBy: "ops",
      request: {
        taskId: request.taskId,
        contextId: request.contextId,
        tool: request.tool,
        preparation: request.preparation,
      },
    });
    expect(context.api.created()).toBe(1);
    await expect(client.registerChange({ request: next })).resolves.toMatchObject({ result });
    await expect(
      client.registerChange({ request: { ...next, intent: "Changed after registration" } }),
    ).rejects.toThrow("cannot be modified");
    await client.prepareExecution({ id: ready.change.id });
    assert(next.tool?.args);
    await expect(
      control.authorize("remediation", "kubernetes_resources_create_or_update", next.tool.args),
    ).resolves.toBe(ready.change.id);
    await client.recordResult({ id: ready.change.id, failed: true });
    expect((await context.store.get(ready.change.id)).failed).toBeNull();
    await client.recordResult({ id: changeId(next.taskId, next.tool.id), failed: false });
    expect((await client.getChange({ id: ready.change.id })).result?.change?.state).toBe(
      ChangeState.SUCCEEDED,
    );
    const subsequent = await client.registerChange({ request: retry(request) });
    expect(subsequent.result?.change?.state).toBe(ChangeState.PENDING);
    expect(subsequent.result?.change?.ticketId).not.toBe(ready.change.ticketId);
  });

  it.each(["session", "engineer", "arguments", "assessment"])(
    "requires new approval after changing the %s",
    async (field) => {
      const { client, request, ready } = await context.approved(false);
      assert(ready.change);
      await client.recordResult({ id: ready.change.id, failed: true });
      const next = retry(request);
      assert(next.tool && next.preparation?.plan);
      if (field === "session") next.contextId = randomUUID();
      if (field === "engineer") next.engineer = "inspection";
      if (field === "arguments") {
        next.tool.args = { resource: "other-configmap", namespace: "aiops-lab" };
        next.preparation.operationHash = operationHash(next.tool.name, next.tool.args);
      }
      if (field === "assessment") next.preparation.plan.impact = "Different resource scope";
      const { result } = await client.registerChange({ request: next });
      expect(result?.change?.state).toBe(ChangeState.PENDING);
      expect(result?.change?.ticketId).not.toBe(ready.change.ticketId);
    },
  );

  it("keeps a closed work order distinct from a human rejection", async () => {
    const { client, request } = context.setup();
    const { result } = await client.registerChange({ request });
    assert(result?.change);
    const { id, ticketId } = result.change;
    await client.recordResult({ id, failed: true });
    const api = new Zammad(context.api.url, "coordinator");
    await api.update(ticketId, { state: "closed" });
    expect((await client.getChange({ id })).result?.change?.state).toBe(ChangeState.CANCELED);
    context.api.decide(Number(ticketId), "rejected", 3, "Scope is too broad");
    expect((await client.getChange({ id })).result?.change?.state).toBe(ChangeState.REJECTED);
    await api.update(ticketId, { state: "open" });
    const next = await client.registerChange({ request: retry(request) });
    expect(next.result?.change?.ticketId).not.toBe(ticketId);
    expect(next.result?.change?.state).toBe(ChangeState.PENDING);
  });
});
