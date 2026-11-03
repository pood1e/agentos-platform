import { createHash } from "node:crypto";
import { Code } from "@connectrpc/connect";
import type { KagentClients } from "../kagent/clients.js";
import { millis } from "../read-model/decode/messages.js";
import { pool } from "../shared/async.js";
import { conflict, fail, hasCode, notFound, unlessMissing } from "../shared/errors.js";
import { type PageRequest, pageOf } from "../shared/page.js";

/** Team knowledge uses the native namespace scope and server-side embeddings. */
export function knowledgeService(clients: KagentClients, namespace: string, ttlDays: number) {
  const etag = (memories: { id: string }[]) =>
    createHash("sha256")
      .update(JSON.stringify(memories.map((item) => item.id).sort()))
      .digest("hex");
  const scope = { target: { case: "teamNamespace" as const, value: namespace } };
  const options = { timeoutMs: 60_000 };
  async function list(request: PageRequest) {
    const { memories } = await clients.memory.list({ scope }, options);
    const query = request.query.toLowerCase().trim();
    const items = memories
      .filter((item) => item.content.toLowerCase().includes(query))
      .sort(
        (a, b) =>
          (millis(b.createdAt) ?? 0) - (millis(a.createdAt) ?? 0) || a.id.localeCompare(b.id),
      );
    const page = pageOf(items, request, "management.knowledge", (item) => ({
      id: item.id,
      time: millis(item.createdAt) ?? 0,
    }));
    return {
      memories: page.items,
      nextPageToken: page.nextPageToken,
      totalSize: page.totalSize,
      etag: etag(memories),
    };
  }
  async function search(query: string, limit = 20) {
    return clients.memory.search(
      {
        scope,
        query,
        limit,
        minScore: 0.3,
      },
      options,
    );
  }
  async function add(content: string) {
    return clients.memory.addSession(
      {
        scope,
        memory: {
          ttlDays,
          content,
          metadata: { source: "console" },
        },
      },
      options,
    );
  }
  async function clear(expected: string) {
    const { memories } = await clients.memory.list({ scope }, options);
    if (etag(memories) !== expected) throw conflict("management.knowledgeChanged");
    await pool(memories, 4, async ({ id }) => {
      await unlessMissing(clients.memory.deleteEntry({ scope, id }, options));
    });
    return {};
  }
  async function remove(id: string) {
    try {
      await clients.memory.deleteEntry({ scope, id }, options);
      return {};
    } catch (error) {
      if (hasCode(error, Code.NotFound)) throw notFound("management.notFound");
      throw fail(Code.Unavailable, "management.unavailable", error);
    }
  }
  return { list, search, add, clear, remove };
}
