import { Code, ConnectError, createClient, createRouterTransport } from "@connectrpc/connect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ManagementService } from "../gen/agentos/management/v1/management_pb.js";
import { object } from "../server/read-model/decode/messages.js";
import { managementEnvironment } from "./management-harness.js";

let env: Awaited<ReturnType<typeof managementEnvironment>>;
let client: ReturnType<typeof createClient<typeof ManagementService>>;
beforeEach(async () => {
  env = await managementEnvironment();
  client = createClient(
    ManagementService,
    createRouterTransport((router) => router.service(ManagementService, env.service)),
  );
});
afterEach(async () => {
  await env.close();
});

describe("shared skill catalog", () => {
  it("validates native sources, preserves ConfigMap metadata and prevents stale updates", async () => {
    const validate = vi.spyOn(env.store, "validate");
    const skill = {
      name: "triage",
      source: { case: "oci" as const, value: `registry.example/triage@sha256:${"a".repeat(64)}` },
    };
    const { item } = await client.saveSkill({
      create: true,
      item: { skill, description: "Triage procedures" },
    });
    expect(validate).toHaveBeenCalledWith(
      "templates",
      expect.objectContaining({
        metadata: { generateName: "skill-validation-", namespace: "agentos" },
      }),
    );
    await client.saveSkill({
      item: { skill: item?.skill, resourceVersion: item?.resourceVersion, description: "Updated" },
    });
    await expect(client.saveSkill({ item })).rejects.toMatchObject({ code: Code.Aborted });
    const cm = env.fake.resources.get("configmaps", "agentos-skills");
    expect(object(object(cm.metadata).annotations)["agentos.dev/ownership"]).toBe("user");
    const { skills } = await client.listSkills({});
    expect(skills[0]?.description).toBe("Updated");
    await client.deleteSkill({ name: "triage", resourceVersion: skills[0]?.resourceVersion });
    expect((await client.listSkills({})).totalSize).toBe(0);
  });
});

describe("native knowledge memory", () => {
  it("deletes only the selected shared record and removes it from retrieval", async () => {
    const first = await client.addKnowledge({ content: "Selected knowledge" });
    const kept = await client.addKnowledge({ content: "Retained knowledge" });
    const foreign = await env.clients.memory.addSession({
      scope: { target: { case: "agentName", value: "agentos/private" } },
      memory: { content: "Other scope" },
    });
    await expect(client.deleteKnowledge({ id: foreign.id })).rejects.toMatchObject({
      code: Code.NotFound,
    });
    await client.deleteKnowledge({ id: first.id });
    expect((await client.listKnowledge({})).memories.map((item) => item.id)).toEqual([kept.id]);
    expect(
      (await client.searchKnowledge({ query: "knowledge" })).memories.map((item) => item.id),
    ).toEqual([kept.id]);
    expect(env.fake.memory.records.has(foreign.id)).toBe(true);
    await expect(client.deleteKnowledge({ id: first.id })).rejects.toMatchObject({
      code: Code.NotFound,
    });
    expect(env.fake.memory.records.size).toBe(2);
  });

  it("never falls back to clearing knowledge when the native single-delete RPC is unavailable", async () => {
    const { id } = await client.addKnowledge({ content: "Keep when native controller is old" });
    const clear = vi.spyOn(env.clients.memory, "delete");
    vi.spyOn(env.clients.memory, "deleteEntry").mockRejectedValueOnce(
      new ConnectError("Unimplemented", Code.Unimplemented),
    );
    await expect(client.deleteKnowledge({ id })).rejects.toMatchObject({ code: Code.Unavailable });
    expect(clear).not.toHaveBeenCalled();
    expect((await client.listKnowledge({})).totalSize).toBe(1);
  });
  it("sends plain content to the native team scope and isolates personal memory", async () => {
    const { id } = await client.addKnowledge({
      content: "Drain a node only after approval.",
    });
    const record = env.fake.memory.records.get(id);
    expect(record).toMatchObject({
      scope: "team:agentos",
      input: { ttlDays: 3650 },
    });
    expect(record?.input.vector).toEqual([]);
    expect((await client.searchKnowledge({ query: "node drain" })).memories[0]?.id).toBe(id);
    expect((await client.listKnowledge({})).memories[0]?.accessCount).toBe(1n);
    await env.clients.memory.addSession({
      scope: { target: { case: "agentName", value: "agentos/private" } },
      memory: { content: "Private memory" },
    });
    expect((await client.listKnowledge({})).totalSize).toBe(1);
    await expect(client.clearKnowledge({ etag: "0".repeat(64) })).rejects.toMatchObject({
      code: Code.Aborted,
    });
    expect(env.fake.memory.records.size).toBe(2);
    await client.clearKnowledge({ etag: (await client.listKnowledge({})).etag });
    expect((await client.listKnowledge({})).totalSize).toBe(0);
    expect(env.fake.memory.records.size).toBe(1);
  });
});
