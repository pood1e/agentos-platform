import { createHash } from "node:crypto";
import { Code, ConnectError } from "@connectrpc/connect";
import { type KagentClients, pool } from "../kagent/clients.js";
import { millis } from "../read-model/decode/messages.js";
import { type PageRequest, pageOf } from "../read-model/page.js";
import { conflict, fail, notFound } from "../shared/errors.js";

export interface KnowledgeConfig {
  namespace: string;
  ttlDays: number;
}

/** Team knowledge uses the native namespace scope and server-side embeddings. */
export function knowledgeService(clients: KagentClients, config: KnowledgeConfig) {
  const etag = (memories: { id: string }[]) =>
    createHash("sha256")
      .update(JSON.stringify(memories.map((item) => item.id).sort()))
      .digest("hex");
  const scope = { target: { case: "teamNamespace" as const, value: config.namespace } };
  const options = () => ({ timeoutMs: 60_000 });
  async function list(request: PageRequest) {
    const { memories } = await clients.memory.list({ scope }, options());
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
      options(),
    );
  }
  async function add(content: string) {
    return clients.memory.addSession(
      {
        scope,
        memory: {
          ttlDays: config.ttlDays,
          content,
          metadata: { source: "console" },
        },
      },
      options(),
    );
  }
  async function clear(expected: string) {
    const { memories } = await clients.memory.list({ scope }, options());
    if (etag(memories) !== expected) throw conflict("management.knowledgeChanged");
    await pool(memories, 4, async ({ id }) => {
      try {
        await clients.memory.deleteEntry({ scope, id }, options());
      } catch (error) {
        if (!(error instanceof ConnectError && error.code === Code.NotFound)) throw error;
      }
    });
    return {};
  }
  async function remove(id: string) {
    try {
      await clients.memory.deleteEntry({ scope, id }, options());
      return {};
    } catch (error) {
      if (error instanceof ConnectError && error.code === Code.NotFound)
        throw notFound("management.notFound");
      throw fail(Code.Unavailable, "management.unavailable", error);
    }
  }
  return { list, search, add, clear, remove };
}
