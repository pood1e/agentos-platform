import { createClient, createRouterTransport } from "@connectrpc/connect";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ManagementService } from "../gen/agentos/management/v1/management_pb.js";
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

it("preserves knowledge added between snapshot validation and deletion", async () => {
  const first = await client.addKnowledge({ content: "Confirmed knowledge" });
  const { etag } = await client.listKnowledge({});
  const list = env.clients.memory.list;
  let concurrentId = "";
  vi.spyOn(env.clients.memory, "list").mockImplementationOnce(async (...args) => {
    const result = await list(...args);
    concurrentId = (await client.addKnowledge({ content: "Concurrent knowledge" })).id;
    return result;
  });
  const clearAll = vi.spyOn(env.clients.memory, "delete");
  await client.clearKnowledge({ etag });
  expect(clearAll).not.toHaveBeenCalled();
  expect(env.fake.memory.records.has(first.id)).toBe(false);
  expect((await client.listKnowledge({})).memories.map((item) => item.id)).toEqual([concurrentId]);
});

it("rejects a changed snapshot even when its record count is unchanged", async () => {
  const first = await client.addKnowledge({ content: "Original" });
  const { etag } = await client.listKnowledge({});
  await client.deleteKnowledge({ id: first.id });
  const replacement = await client.addKnowledge({ content: "Replacement" });
  await expect(client.clearKnowledge({ etag })).rejects.toMatchObject({
    rawMessage: "management.knowledgeChanged",
  });
  expect(env.fake.memory.records.has(replacement.id)).toBe(true);
});
