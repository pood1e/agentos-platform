import { create, fromJson } from "@bufbuild/protobuf";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import {
  MessageSchema,
  Role,
  SendMessageConfigurationSchema,
  SendMessageResponseSchema,
} from "../../gen/a2a_pb.js";
import { RoleDefinitionSchema } from "../../gen/agentos/console/v1/role_pb.js";
import { InvokeSessionInputSchema } from "../../gen/agentos/kagent/v1/wire_pb.js";
import {
  SearchKnowledgeRequestSchema,
  SearchKnowledgeResponseSchema,
} from "../../gen/agentos/management/v1/management_pb.js";
import {
  ListAgentsRequestSchema,
  ListAgentsResponseSchema,
} from "../../gen/kagent/api/v1/agents_pb.js";
import type { ResourceReference } from "../../gen/kagent/api/v1/common_pb.js";
import {
  CreateSessionRequestSchema,
  CreateSessionResponseSchema,
} from "../../gen/kagent/api/v1/sessions_pb.js";
import { ListToolServersResponseSchema } from "../../gen/kagent/api/v1/tools_pb.js";
import roleSchema from "../../gen/schema/agentos.console.v1.RoleDefinition.jsonschema.bundle.json" with {
  type: "json",
};
import messageSchema from "../../gen/schema/agentos.kagent.v1.InvokeSessionInput.jsonschema.bundle.json" with {
  type: "json",
};
import searchSchema from "../../gen/schema/agentos.management.v1.SearchKnowledgeRequest.jsonschema.bundle.json" with {
  type: "json",
};
import createSchema from "../../gen/schema/kagent.api.v1.CreateSessionRequest.jsonschema.bundle.json" with {
  type: "json",
};
import listSchema from "../../gen/schema/kagent.api.v1.ListAgentsRequest.jsonschema.bundle.json" with {
  type: "json",
};
import toolSchema from "../../gen/schema/kagent.api.v1.ListToolServersRequest.jsonschema.bundle.json" with {
  type: "json",
};
import manifest from "../../package.json" with { type: "json" };
import { collaborationExecution } from "../authorization/context.js";
import type { BindingView } from "../governance/bindings.js";
import type { KagentClients } from "../kagent/clients.js";
import { toolMetadata } from "../kagent/tool-metadata.js";
import type { knowledgeService } from "../knowledge/service.js";
import { agentInfo, agentKey, systemRoles } from "../read-model/agents.js";
import { hitlExtension } from "../read-model/decode/hitl.js";
import { messageIdentity } from "../shared/idempotency.js";
import { inputSchema, result, validator } from "./schema.js";

/** Workspace collaboration, role drafting and shared knowledge retrieval. */
export function sessionTools(
  clients: KagentClients,
  namespace: string,
  access: BindingView,
  knowledge: Pick<ReturnType<typeof knowledgeService>, "search">,
) {
  const metadata = toolMetadata(clients);
  const inWorkspace = async () => {
    const servers = (
      await clients.tools.listToolServers({}, { timeoutMs: 10_000 })
    ).toolServers.filter((server) => server.ref.startsWith(`${namespace}/`));
    const policy = await access();
    return metadata.modelServers(servers, (server) => policy.catalogServer(server, servers));
  };
  // Engineers are the workspace agents other than the console's own assistants.
  const isEngineer = async (ref?: ResourceReference) => {
    if (ref?.namespace !== namespace) return false;
    const { agent } = await clients.agents.getAgent({ ref }, { timeoutMs: 10_000 });
    return !!agent && !systemRoles.has(agentInfo(agent).role);
  };
  return createMcpHandler(({ authInfo }) => {
    const server = new McpServer({ name: "team-sessions", version: manifest.version });
    const tools: Array<[string, import("@modelcontextprotocol/server").RegisteredTool]> = [];
    tools.push([
      "search_knowledge",
      server.registerTool(
        "search_knowledge",
        {
          description:
            "Search the team's shared knowledge by meaning. Returns up to five relevant verified findings with scores, stored sources and timestamps. Check applicability against current evidence. This tool only reads knowledge; the knowledge role curates it.",
          inputSchema: inputSchema(searchSchema),
          annotations: { readOnlyHint: true, destructiveHint: false },
        },
        async (args) => {
          const request = fromJson(SearchKnowledgeRequestSchema, args);
          const validation = validator.validate(SearchKnowledgeRequestSchema, request);
          if (validation.kind !== "valid") throw new Error(String(validation.error));
          const response = await knowledge.search(request.query, 5);
          return result(
            SearchKnowledgeResponseSchema,
            create(SearchKnowledgeResponseSchema, { memories: response.memories }),
          );
        },
      ),
    ]);
    tools.push([
      "list_agents",
      server.registerTool(
        "list_agents",
        {
          description: `Discover available Agents and their capabilities and readiness in workspace ${namespace}. Omit namespace to use this workspace.`,
          inputSchema: inputSchema(listSchema),
          annotations: { readOnlyHint: true },
        },
        async (args) => {
          const request = fromJson(ListAgentsRequestSchema, args);
          request.namespace ||= namespace;
          if (request.namespace !== namespace)
            throw new Error("Agent namespace is outside this workspace");
          const response = await clients.agents.listAgents(request, { timeoutMs: 10_000 });
          response.agents = response.agents.filter(
            (agent) => !systemRoles.has(agentInfo(agent).role),
          );
          return result(ListAgentsResponseSchema, response);
        },
      ),
    ]);
    tools.push([
      "create_session",
      server.registerTool(
        "create_session",
        {
          description:
            "Create an independent context with a chosen engineer. Give name a short purpose and environment. Use a fresh random UUID requestId; reuse identical inputs only for creation retries. Continue related work in a known Session instead. Invoke the returned session.id with concise goal, context, deliverable and scope.",
          inputSchema: inputSchema(createSchema),
          annotations: { destructiveHint: false, idempotentHint: true },
        },
        async (args) => {
          const request = fromJson(CreateSessionRequestSchema, args);
          if (!(await isEngineer(request.agent)))
            throw new Error("Create sessions only with engineers returned by list_agents");
          const scope = collaborationExecution.getStore();
          request.requestId = messageIdentity(
            "collaboration",
            namespace,
            scope?.parentSessionId ?? "",
            request.requestId,
          );
          const response = await clients.sessions.createSession(request, { timeoutMs: 60_000 });
          if (scope) {
            if (!response.session) throw new Error("Native session is missing");
            await scope.created(response.session);
          }
          return result(CreateSessionResponseSchema, response);
        },
      ),
    ]);
    tools.push([
      "dispatch_session",
      server.registerTool(
        "dispatch_session",
        {
          description:
            "Dispatch independent background work without waiting for completion. Uses the same session_id, message_id and message fields as invoke_session. Use a fresh random UUID message_id and reuse identical inputs for retries. Returns the accepted A2A Task; acceptance does not mean completion. Use for knowledge persistence after the main goal is verified. Use invoke_session when the main result depends on the child's answer.",
          inputSchema: inputSchema(messageSchema),
          annotations: { destructiveHint: false },
        },
        async (args) => {
          const input = fromJson(InvokeSessionInputSchema, args);
          input.message = input.message?.trim();
          const validation = validator.validate(InvokeSessionInputSchema, input);
          if (validation.kind !== "valid") throw new Error(String(validation.error));
          const message = create(MessageSchema, {
            contextId: input.sessionId,
            messageId: input.messageId,
            role: Role.USER,
            parts: [{ content: { case: "text", value: input.message ?? "" } }],
          });
          const { session } = await clients.sessions.getSession(
            { sessionId: message.contextId },
            { timeoutMs: 10_000 },
          );
          if (!session?.agent || !(await isEngineer(session.agent)))
            throw new Error("Dispatch only to sessions of engineers returned by list_agents");
          await collaborationExecution.getStore()?.invoke(session);
          message.extensions = [...new Set([...message.extensions, hitlExtension])];
          const response = await clients.a2a.sendMessage(
            {
              tenant: agentKey(session.agent),
              message,
              configuration: create(SendMessageConfigurationSchema, { returnImmediately: true }),
            },
            { timeoutMs: 30_000, headers: { "A2A-Extensions": hitlExtension } },
          );
          return result(SendMessageResponseSchema, response);
        },
      ),
    ]);
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
