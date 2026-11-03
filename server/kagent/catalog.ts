import type { AgentTemplate } from "../../gen/kagent/api/v1/agent_templates_pb.js";
import type { Agent } from "../../gen/kagent/api/v1/agents_pb.js";
import type { ToolServer } from "../../gen/kagent/api/v1/tools_pb.js";
import { eachPage } from "../shared/async.js";
import type { KagentClients } from "./clients.js";

type ReadOptions = { timeoutMs?: number; signal?: AbortSignal };

async function collect<T>(
  fetchPage: (pageToken: string) => Promise<{ items: T[]; token: string }>,
): Promise<T[]> {
  const all: T[] = [];
  await eachPage(fetchPage, (items) => all.push(...items));
  return all;
}

export const listNativeAgents = (
  clients: KagentClients,
  namespace: string,
  options?: ReadOptions,
): Promise<Agent[]> =>
  collect(async (pageToken) => {
    const result = await clients.agents.listAgents(
      { namespace, page: { pageToken, limit: 100 } },
      options,
    );
    return { items: result.agents, token: result.page?.nextPageToken ?? "" };
  });

export const listNativeTemplates = (
  clients: KagentClients,
  namespace: string,
  options?: ReadOptions,
): Promise<AgentTemplate[]> =>
  collect(async (pageToken) => {
    const result = await clients.templates.listAgentTemplates(
      { namespace, page: { pageToken, limit: 100 } },
      options,
    );
    return { items: result.agentTemplates, token: result.page?.nextPageToken ?? "" };
  });

/** Tool servers are listed cluster-wide; a workspace uses only those in its namespace. */
export async function listWorkspaceToolServers(
  clients: KagentClients,
  namespace: string,
  options?: ReadOptions,
): Promise<ToolServer[]> {
  const { toolServers } = await clients.tools.listToolServers({}, options);
  return toolServers.filter((server) => server.ref.startsWith(`${namespace}/`));
}
