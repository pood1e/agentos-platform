import { Code, ConnectError } from "@connectrpc/connect";
import OpenAI from "openai";
import type { SessionMemoryInput } from "../../gen/kagent/api/v1alpha1/memory_pb.js";
import type { KagentClients } from "../kagent/clients.js";
import { millis } from "../read-model/decode/messages.js";
import { type PageRequest, pageOf } from "../read-model/page.js";
import { conflict, fail, invalid, notFound } from "../shared/errors.js";

export interface KnowledgeConfig {
  url: string;
  token: string;
  model: string;
  scope: Pick<SessionMemoryInput, "agentName" | "userId" | "ttlDays">;
}

/** The console and read-only MCP search share the knowledge curator's native memory. */
export function knowledgeService(clients: KagentClients, config: KnowledgeConfig) {
  const embedding = new OpenAI({
    baseURL: config.url,
    apiKey: config.token,
    timeout: 60_000,
    maxRetries: 1,
  });
  async function vector(input: string) {
    if (!input.trim()) throw invalid("management.invalid");
    try {
      const response = await embedding.embeddings.create({
        model: config.model,
        input,
        encoding_format: "float",
        dimensions: 768,
      });
      const result = response.data[0]?.embedding;
      if (result?.length !== 768) throw new Error("Invalid embedding dimensions");
      return result;
    } catch {
      throw fail(Code.Unavailable, "management.embeddingFailed");
    }
  }
  async function list(request: PageRequest) {
    const { memories } = await clients.memory.list(config.scope, { timeoutMs: 10_000 });
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
    return { memories: page.items, nextPageToken: page.nextPageToken, totalSize: page.totalSize };
  }
  async function search(query: string, limit = 20) {
    return clients.memory.search(
      { ...config.scope, vector: await vector(query), limit, minScore: 0.3 },
      { timeoutMs: 10_000 },
    );
  }
  async function add(content: string) {
    return clients.memory.addSession(
      {
        memory: {
          ...config.scope,
          content,
          vector: await vector(content),
          metadata: { source: "console" },
        },
      },
      { timeoutMs: 10_000 },
    );
  }
  async function clear(expected: number) {
    const { memories } = await clients.memory.list(config.scope, { timeoutMs: 10_000 });
    if (memories.length !== expected) throw conflict("management.knowledgeChanged");
    await clients.memory.delete(config.scope, { timeoutMs: 10_000 });
    return {};
  }
  async function remove(id: string) {
    try {
      await clients.memory.deleteEntry({ ...config.scope, id }, { timeoutMs: 10_000 });
      return {};
    } catch (error) {
      if (error instanceof ConnectError && error.code === Code.NotFound)
        throw notFound("management.notFound");
      throw fail(Code.Unavailable, "management.unavailable", error);
    }
  }
  return { list, search, add, clear, remove, vector };
}
