import { Code, ConnectError } from "@connectrpc/connect";
import {
  getToolUiResourceUri,
  isToolVisibilityAppOnly,
  isToolVisibilityModelOnly,
  McpUiToolMetaSchema,
} from "@modelcontextprotocol/ext-apps/app-bridge";
import { LRUCache } from "lru-cache";
import type { MCPAppTool, ToolServer } from "../../gen/kagent/api/v1/tools_pb.js";
import { pool } from "../shared/async.js";
import type { KagentClients } from "./clients.js";

export const appOnly = (tool: MCPAppTool) => {
  const ui = tool.meta?.value?.ui;
  if (ui !== undefined) McpUiToolMetaSchema.parse(ui);
  return isToolVisibilityAppOnly({ _meta: tool.meta?.value });
};
export const appResource = (tool: MCPAppTool) => getToolUiResourceUri({ _meta: tool.meta?.value });
export const appVisible = (tool: MCPAppTool) => {
  const ui = tool.meta?.value?.ui;
  return (
    (ui === undefined || McpUiToolMetaSchema.safeParse(ui).success) &&
    !isToolVisibilityModelOnly({ _meta: tool.meta?.value })
  );
};

export function toolMetadata(clients: KagentClients) {
  const reference = (server: ToolServer) => {
    const [namespace, name] = server.ref.split("/");
    return { ref: { namespace, name }, groupKind: server.groupKind };
  };
  const toolCache = new LRUCache<string, MCPAppTool[], ToolServer>({
    max: 256,
    ttl: 60_000,
    fetchMethod: async (_key, _stale, { context }) =>
      (await clients.tools.listMCPAppTools({ server: reference(context) }, { timeoutMs: 10_000 }))
        .tools,
  });
  const serverCache = new LRUCache<string, ToolServer[]>({
    max: 1,
    ttl: 5_000,
    fetchMethod: async () =>
      (await clients.tools.listToolServers({}, { timeoutMs: 5_000 })).toolServers,
  });
  const servers = async () => (await serverCache.fetch("servers")) ?? [];
  const tools = async (server: ToolServer) =>
    (await toolCache.fetch(`${server.groupKind}:${server.ref}`, { context: server })) ?? [];
  async function modelServers(
    servers: ToolServer[],
    source: (server: ToolServer) => ToolServer = (server) => server,
  ) {
    const result = new Map<string, ToolServer>();
    await pool(servers, 4, async (server) => {
      if (!server.discoveredTools.length) {
        result.set(server.ref, server);
        return;
      }
      try {
        const visible = new Set(
          await modelTools(
            source(server),
            server.discoveredTools.map((tool) => tool.name),
          ),
        );
        result.set(server.ref, {
          ...server,
          discoveredTools: server.discoveredTools.filter((tool) => visible.has(tool.name)),
        });
      } catch (cause) {
        throw new ConnectError(
          "MCP tool discovery unavailable",
          Code.Unavailable,
          undefined,
          undefined,
          cause,
        );
      }
    });
    return servers.map((server) => result.get(server.ref) ?? server);
  }
  async function modelTools(server: ToolServer, names: string[]) {
    const hidden = new Set((await tools(server)).filter(appOnly).map((tool) => tool.name));
    return names.filter((name) => !hidden.has(name));
  }
  return { tools, reference, modelServers, modelTools, servers };
}

export type ToolMetadata = ReturnType<typeof toolMetadata>;
