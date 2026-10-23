import { readFileSync } from "node:fs";
import type { KagentConfig } from "../shared/config.js";
import type { KnowledgeConfig } from "./service.js";

export function knowledgeConfig(workspace: KagentConfig, env = process.env): KnowledgeConfig {
  return {
    url: `${env.AGENTOS_GATEWAY_URL ?? "http://agentos-gateway:8080"}/v1`,
    token: async () =>
      readFileSync(env.AGENTOS_MODEL_TOKEN_FILE ?? "/var/run/agentos-model/token", "utf8").trim(),
    model: env.AGENTOS_EMBEDDING_MODEL ?? "embeddinggemma:300m",
    scope: {
      agentName: `${workspace.namespace}/knowledge`,
      userId: workspace.userId,
      ttlDays: Number(env.AGENTOS_KNOWLEDGE_TTL_DAYS ?? "3650"),
    },
  };
}
