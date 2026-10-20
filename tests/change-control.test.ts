import assert from "node:assert/strict";
import { fromJson } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import { describe, expect, it } from "vitest";
import { ChangeState, Governance } from "../gen/agentos/governance/v1/change_pb.js";
import { changeId } from "../server/shared/change-digest.js";
import { changeFixture, database } from "./change-control-fixture.js";

function present<T>(value: T | null | undefined): T {
  assert(value != null);
  return value;
}

describe.skipIf(!database)("environment change control with PostgreSQL", () => {
  const context = changeFixture();
  const { setup, approved } = context;
  it("deduplicates registration and rejects edits to an existing native call", async () => {
    const { client, request } = setup();
    const results = await Promise.all([
      client.registerChange({ request }),
      client.registerChange({ request }),
    ]);
    expect(results[0].result?.change?.id).toBe(results[1].result?.change?.id);
    expect(context.api.created()).toBe(1);
    await expect(
      client.registerChange({ request: { ...request, intent: "A different plan" } }),
    ).rejects.toThrow("cannot be modified");
  });
  it("lets reads through and blocks writes without a prepared work order", async () => {
    const { control } = setup();
    await expect(
      control.authorize("inspection", "kubernetes_pods_list", { namespace: "agentos-lab" }),
    ).resolves.toBeUndefined();
    await expect(
      control.authorize("remediation", "kubernetes_resources_create_or_update", {}),
    ).rejects.toThrow("approved change");
    expect(context.api.created()).toBe(0);
  });
  it("records the native human approval identity", async () => {
    const { ready } = await approved();
    expect(ready.change).toMatchObject({
      state: ChangeState.APPROVED,
      decidedBy: "ops",
    });
    expect(ready).not.toHaveProperty("grant");
  });
  it("does not configure a change-control service for simulation", () => {
    expect(() => setup(Governance.DIRECT)).toThrow("only configured for approval environments");
  });
  it("rejects a fake approval field update by the requesting identity", async () => {
    const { client, request } = setup(),
      { result } = await client.registerChange({ request });
    context.api.decide(Number(present(present(result).change).ticketId), "approved", 1);
    await expect(client.getChange({ id: present(present(result).change).id })).rejects.toThrow(
      "unauthorized identity",
    );
    expect(
      (await context.store.get(changeId(request.taskId, request.tool?.id ?? ""))).claimed_at,
    ).toBeNull();
  });
  it("binds approval to exact arguments, engineer and environment", async () => {
    const { control, request } = await approved();
    for (const [engineer, args] of [
      ["inspection", present(present(request.tool).args)],
      ["remediation", { namespace: "production" }],
    ] as const)
      await expect(
        control.authorize(engineer, "kubernetes_resources_create_or_update", args),
      ).rejects.toThrow();
    const other = setup();
    await expect(
      other.client.registerChange({
        request: {
          ...request,
          tool: {
            ...present(request.tool),
            name: "another-real-kubernetes_resources_create_or_update",
          },
        },
      }),
    ).rejects.toThrow("another environment");
  });
  it("claims an approved operation atomically even when two calls race", async () => {
    const { control, request } = await approved();
    const results = await Promise.allSettled(
      Array.from({ length: 2 }, () =>
        control.authorize(
          "remediation",
          "kubernetes_resources_create_or_update",
          present(present(request.tool).args),
        ),
      ),
    );
    expect(results.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    await expect(
      control.authorize(
        "remediation",
        "kubernetes_resources_create_or_update",
        present(present(request.tool).args),
      ),
    ).rejects.toThrow("prepared and approved");
  });
  it("rechecks a revoked approval before executing", async () => {
    const { control, request, ready } = await approved();
    context.api.decide(Number(present(ready.change).ticketId), "rejected", 3);
    await expect(
      control.authorize(
        "remediation",
        "kubernetes_resources_create_or_update",
        present(present(request.tool).args),
      ),
    ).rejects.toThrow("revoked");
  });
  it("keeps rejected work orders distinct from execution failures", async () => {
    const { client, request } = setup();
    const result = present((await client.registerChange({ request })).result);
    const change = present(result.change);
    context.api.decide(Number(change.ticketId), "rejected", 3, "Scope could not be verified");
    await client.recordResult({
      id: change.id,
      failed: true,
      output: fromJson(ValueSchema, { error: "Tool call rejected" }),
    });
    expect((await client.getChange({ id: change.id })).result?.change?.state).toBe(
      ChangeState.REJECTED,
    );
    expect((await context.store.get(change.id)).claimed_at).toBeNull();
  });
  it("rejects an unclaimed success without ending the approval", async () => {
    const { client, ready } = await approved();
    const id = present(ready.change).id;
    await expect(client.recordResult({ id, failed: false })).rejects.toThrow("claimed approval");
    expect((await client.getChange({ id })).result?.change?.state).toBe(ChangeState.APPROVED);
    expect((await context.store.get(id)).claimed_at).toBeNull();
  });
  it("persists execution claims and retries failed result delivery", async () => {
    const { control, client, request, ready } = await approved();
    await control.authorize(
      "remediation",
      "kubernetes_resources_create_or_update",
      present(present(request.tool).args),
    );
    context.api.failNextResult();
    const result = {
      id: present(ready.change).id,
      failed: false,
      output: fromJson(ValueSchema, { created: true }),
    };
    await expect(client.recordResult(result)).rejects.toThrow("503");
    expect((await context.store.get(result.id)).reported_at).toBeNull();
    expect((await client.recordResult(result)).result?.change?.state).toBe(ChangeState.SUCCEEDED);
    await client.recordResult(result);
    expect(context.api.reported()).toBe(1);
    expect((await context.store.get(result.id)).claimed_at).not.toBeNull();
  });
});
