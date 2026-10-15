import type { KagentConfig } from "../shared/config.js";
import type { KnowledgeConfig } from "./service.js";

export function knowledgeConfig(workspace: KagentConfig, env = process.env): KnowledgeConfig {
  return {
    url: `${env.AGENTOS_GATEWAY_URL ?? "http://agentos-gateway:8080"}/v1`,
    token: env.AGENTOS_GATEWAY_TOKEN ?? "local-development",
    model: env.AGENTOS_EMBEDDING_MODEL ?? "embeddinggemma:300m",
    scope: {
      agentName: `${workspace.namespace.replaceAll("-", "_")}__NS__knowledge`,
      userId: workspace.userId,
      ttlDays: Number(env.AGENTOS_KNOWLEDGE_TTL_DAYS ?? "3650"),
    },
  };
}
