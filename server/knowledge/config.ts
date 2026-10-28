import type { KnowledgeConfig } from "./service.js";

export function knowledgeConfig(
  workspace: { namespace: string },
  env = process.env,
): KnowledgeConfig {
  return {
    namespace: workspace.namespace,
    ttlDays: Number(env.AGENTOS_KNOWLEDGE_TTL_DAYS ?? "3650"),
  };
}
