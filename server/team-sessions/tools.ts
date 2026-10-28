import { create, fromJson } from "@bufbuild/protobuf";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { RoleDefinitionSchema } from "../../gen/agentos/console/v1/role_pb.js";
import { ListToolServersResponseSchema } from "../../gen/kagent/api/v1/tools_pb.js";
import roleSchema from "../../gen/schema/agentos.console.v1.RoleDefinition.jsonschema.bundle.json" with {
  type: "json",
};
import toolSchema from "../../gen/schema/kagent.api.v1.ListToolServersRequest.jsonschema.bundle.json" with {
  type: "json",
};
import manifest from "../../package.json" with { type: "json" };
import type { BindingView } from "../governance/bindings.js";
import type { KagentClients } from "../kagent/clients.js";
import { toolMetadata } from "../kagent/tool-metadata.js";
import { systemRoles } from "../read-model/agents.js";
import { inputSchema, result, validator } from "./schema.js";

/** Role drafting and the workspace's business tool catalog. */
export function sessionTools(clients: KagentClients, namespace: string, access: BindingView) {
  const metadata = toolMetadata(clients);
  const inWorkspace = async () => {
    const servers = (
      await clients.tools.listToolServers({}, { timeoutMs: 10_000 })
    ).toolServers.filter((server) => server.ref.startsWith(`${namespace}/`));
    const policy = await access();
    return metadata.modelServers(servers, (server) => policy.catalogServer(server, servers));
  };
  return createMcpHandler(({ authInfo }) => {
    const server = new McpServer({ name: "team-sessions", version: manifest.version });
    const tools: Array<[string, import("@modelcontextprotocol/server").RegisteredTool]> = [];
    tools.push([
      "list_role_tools",
      server.registerTool(
        "list_role_tools",
        {
          description:
            "Discover the MCP servers, exact tool names and descriptions a new role can bind. Environment services require an engineer identity, so they are not listed. Returns the official kagent ListToolServersResponse. Discovery is read-only and does not invoke any discovered tool.",
          inputSchema: inputSchema(toolSchema),
          annotations: { readOnlyHint: true },
        },
        async () => {
          const [servers, view] = await Promise.all([inWorkspace(), access()]);
          const usable = servers.filter((server) =>
            view.usable("", server.ref.split("/").at(-1) ?? server.ref),
          );
          return result(
            ListToolServersResponseSchema,
            create(ListToolServersResponseSchema, { toolServers: usable }),
          );
        },
      ),
    ]);
    tools.push([
      "prepare_role",
      server.registerTool(
        "prepare_role",
        {
          description:
            "Prepare a complete editable role draft. Tool bindings name a RemoteMCPServer and exact discovered tool names; approval follows the execution requirements and tools it denies are rejected. This is read-only: it does not create or update templates, engineers, or resources. A successful result becomes the editable role form.",
          inputSchema: inputSchema(roleSchema),
          annotations: { readOnlyHint: true },
        },
        async (args) => {
          const role = fromJson(RoleDefinitionSchema, args);
          role.resourceVersion = "";
          const validation = validator.validate(RoleDefinitionSchema, role);
          if (validation.kind !== "valid") throw new Error(String(validation.error));
          const tools = systemRoles.has(role.name)
            ? undefined
            : (await access()).bindings(role.name, role.tools, await inWorkspace(), true);
          if (!tools)
            throw new Error(
              "Use a new role name and only tools the execution requirements grants to it",
            );
          role.tools = tools;
          return result(RoleDefinitionSchema, role);
        },
      ),
    ]);
    for (const [name, tool] of tools)
      if (authInfo && !authInfo.scopes.includes(name)) tool.disable();
    return server;
  });
}
