import { Code, ConnectError } from "@connectrpc/connect";
import OpenAI, { type ClientOptions } from "openai";
import type {
  MemoryServiceListRequest,
  SessionMemoryInput,
} from "../../gen/kagent/runtime/v1/memory_pb.js";
import type { KagentClients } from "../kagent/clients.js";
import { millis } from "../read-model/decode/messages.js";
import { type PageRequest, pageOf } from "../read-model/page.js";
import type { KagentConfig } from "../shared/config.js";
import { conflict, fail, invalid, notFound } from "../shared/errors.js";

export interface KnowledgeConfig {
  url: string;
  token: NonNullable<ClientOptions["apiKey"]>;
  model: string;
  scope: Pick<MemoryServiceListRequest, "agentName"> &
    Pick<SessionMemoryInput, "ttlDays"> &
    Pick<KagentConfig, "userId">;
}

/** The console and read-only MCP search share the knowledge curator's native memory. */
export function knowledgeService(clients: KagentClients, config: KnowledgeConfig) {
  const options = (timeoutMs = 10_000) => ({
    timeoutMs,
    headers: { "x-user-id": config.scope.userId },
  });
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
    const { memories } = await clients.memory.list(
      { agentName: config.scope.agentName },
      options(),
    );
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
      {
        managementAgent: config.scope.agentName,
        vector: await vector(query),
        limit,
        minScore: 0.3,
      },
      options(),
    );
  }
  async function add(content: string) {
    return clients.memory.addSession(
      {
        managementAgent: config.scope.agentName,
        memory: {
          ttlDays: config.scope.ttlDays,
          content,
          vector: await vector(content),
          metadata: { source: "console" },
        },
      },
      options(),
    );
  }
  async function clear(expected: number) {
    const { memories } = await clients.memory.list(
      { agentName: config.scope.agentName },
      options(),
    );
    if (memories.length !== expected) throw conflict("management.knowledgeChanged");
    await clients.memory.delete({ agentName: config.scope.agentName }, options());
    return {};
  }
  async function remove(id: string) {
    try {
      await clients.memory.deleteEntry({ agentName: config.scope.agentName, id }, options());
      return {};
    } catch (error) {
      if (error instanceof ConnectError && error.code === Code.NotFound)
        throw notFound("management.notFound");
      throw fail(Code.Unavailable, "management.unavailable", error);
    }
  }
  return { list, search, add, clear, remove, vector };
}
