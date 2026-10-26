import { Code, ConnectError } from "@connectrpc/connect";
import {
  getToolUiResourceUri,
  isToolVisibilityAppOnly,
  isToolVisibilityModelOnly,
  McpUiToolMetaSchema,
} from "@modelcontextprotocol/ext-apps/app-bridge";
import { LRUCache } from "lru-cache";
import type { ToolRequirement } from "../../gen/agentos/console/v1/tool_pb.js";
import type { MCPAppTool, ToolServer } from "../../gen/kagent/api/v1/tools_pb.js";
import { type KagentClients, pool } from "./clients.js";

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
  const cache = new LRUCache<string, MCPAppTool[]>({ max: 256, ttl: 60_000 });
  const serverCache = new LRUCache<string, Promise<ToolServer[]>>({ max: 1, ttl: 5_000 });
  async function servers() {
    let request = serverCache.get("servers");
    if (!request) {
      request = clients.tools
        .listToolServers({}, { timeoutMs: 5_000 })
        .then((result) => result.toolServers)
        .catch((error) => {
          serverCache.delete("servers");
          throw error;
        });
      serverCache.set("servers", request);
    }
    return request;
  }
  const pending = new Map<string, Promise<MCPAppTool[]>>();
  const reference = (server: ToolServer) => {
    const [namespace, name] = server.ref.split("/");
    return { ref: { namespace, name }, groupKind: server.groupKind };
  };
  async function tools(server: ToolServer) {
    const key = `${server.groupKind}:${server.ref}`;
    const known = cache.get(key);
    if (known) return known;
    let request = pending.get(key);
    if (!request) {
      request = clients.tools
        .listMCPAppTools({ server: reference(server) }, { timeoutMs: 10_000 })
        .then(({ tools }) => {
          cache.set(key, tools);
          return tools;
        })
        .finally(() => pending.delete(key));
      pending.set(key, request);
    }
    return request;
  }
  async function modelServers(
    servers: ToolServer[],
    source: (server: ToolServer) => ToolServer = (server) => server,
  ) {
    const result = new Map<string, ToolServer>();
    await pool(servers, 4, async (server) => {
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
  async function appOnlyCalls(
    references: Pick<ToolRequirement, "server" | "tool">[],
    namespace: string,
  ) {
    if (!references.length) return false;
    try {
      const toolServers = await servers();
      for (const reference of references) {
        const server = toolServers.find(
          (server) => server.ref === `${namespace}/${reference.server}`,
        );
        if (!server) throw new Error("MCP server metadata is missing");
        const tool = (await tools(server)).find((tool) => tool.name === reference.tool);
        if (!tool) throw new Error("MCP tool metadata is missing");
        if (appOnly(tool)) return true;
      }
      return false;
    } catch (cause) {
      throw new ConnectError(
        "MCP tool metadata unavailable",
        Code.Unavailable,
        undefined,
        undefined,
        cause,
      );
    }
  }
  return { tools, reference, modelServers, modelTools, appOnlyCalls, servers };
}

export type ToolMetadata = ReturnType<typeof toolMetadata>;
