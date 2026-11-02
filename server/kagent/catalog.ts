import type { AgentTemplate } from "../../gen/kagent/api/v1/agent_templates_pb.js";
import type { Agent } from "../../gen/kagent/api/v1/agents_pb.js";
import { eachPage, type KagentClients } from "./clients.js";

type ReadOptions = { timeoutMs?: number; signal?: AbortSignal };

export async function listNativeAgents(
  clients: KagentClients,
  namespace: string,
  options?: ReadOptions,
): Promise<Agent[]> {
  const agents: Agent[] = [];
  await eachPage(
    async (pageToken) => {
      const result = await clients.agents.listAgents(
        { namespace, page: { pageToken, limit: 100 } },
        options,
      );
      return { items: result.agents, token: result.page?.nextPageToken ?? "" };
    },
    (items) => agents.push(...items),
  );
  return agents;
}

export async function listNativeTemplates(
  clients: KagentClients,
  namespace: string,
  options?: ReadOptions,
): Promise<AgentTemplate[]> {
  const templates: AgentTemplate[] = [];
  await eachPage(
    async (pageToken) => {
      const result = await clients.templates.listAgentTemplates(
        { namespace, page: { pageToken, limit: 100 } },
        options,
      );
      return { items: result.agentTemplates, token: result.page?.nextPageToken ?? "" };
    },
    (items) => templates.push(...items),
  );
  return templates;
}
