import { create, fromJson } from "@bufbuild/protobuf";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import {
  MessageSchema,
  Role,
  SendMessageConfigurationSchema,
  SendMessageResponseSchema,
} from "../../gen/a2a_pb.js";
import { RoleDefinitionSchema, ToolBindingSchema } from "../../gen/agentos/console/v1/role_pb.js";
import {
  PrepareChangeRequestSchema,
  PrepareChangeResponseSchema,
} from "../../gen/agentos/governance/v1/change_pb.js";
import {
  SearchKnowledgeRequestSchema,
  SearchKnowledgeResponseSchema,
} from "../../gen/agentos/management/v1/management_pb.js";
import {
  ListAgentsRequestSchema,
  ListAgentsResponseSchema,
} from "../../gen/kagent/api/v1alpha1/agents_pb.js";
import type { ResourceReference } from "../../gen/kagent/api/v1alpha1/common_pb.js";
import {
  CreateSessionRequestSchema,
  CreateSessionResponseSchema,
} from "../../gen/kagent/api/v1alpha1/sessions_pb.js";
import { ListToolServersResponseSchema } from "../../gen/kagent/api/v1alpha1/tools_pb.js";
import roleSchema from "../../gen/schema/agentos.console.v1.RoleDefinition.jsonschema.bundle.json" with {
  type: "json",
};
import changeSchema from "../../gen/schema/agentos.governance.v1.PrepareChangeRequest.jsonschema.bundle.json" with {
  type: "json",
};
import searchSchema from "../../gen/schema/agentos.management.v1.SearchKnowledgeRequest.jsonschema.bundle.json" with {
  type: "json",
};
import createSchema from "../../gen/schema/kagent.api.v1alpha1.CreateSessionRequest.jsonschema.bundle.json" with {
  type: "json",
};
import listSchema from "../../gen/schema/kagent.api.v1alpha1.ListAgentsRequest.jsonschema.bundle.json" with {
  type: "json",
};
import toolSchema from "../../gen/schema/kagent.api.v1alpha1.ListToolServersRequest.jsonschema.bundle.json" with {
  type: "json",
};
import messageSchema from "../../gen/schema/lf.a2a.v1.Message.jsonschema.bundle.json" with {
  type: "json",
};
import manifest from "../../package.json" with { type: "json" };
import type { KagentClients } from "../kagent/clients.js";
import type { nativeInvocation } from "../kagent/invoke-session.js";
import type { knowledgeService } from "../knowledge/service.js";
import type { BindingView } from "../operations/bindings.js";
import { ChangePreparationError, type changePreparation } from "../operations/preparation.js";
import { agentInfo, agentKey, systemRoles } from "../read-model/agents.js";
import { hitlExtension } from "../read-model/decode/hitl.js";
import { coordinatorDelegation } from "./delegate.js";
import { inputSchema, result, validator } from "./schema.js";

/** Workspace collaboration, role drafting and shared knowledge retrieval. */
export function sessionTools(
  clients: KagentClients,
  namespace: string,
  access: BindingView,
  knowledge: Pick<ReturnType<typeof knowledgeService>, "search">,
  invoke: ReturnType<typeof nativeInvocation>,
  prepareChange: ReturnType<typeof changePreparation>,
) {
  const delegate = coordinatorDelegation(clients, namespace, invoke);
  const inWorkspace = async () =>
    (await clients.tools.listToolServers({}, { timeoutMs: 10_000 })).toolServers.filter((server) =>
      server.ref.startsWith(`${namespace}/`),
    );
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
      "prepare_change",
      server.registerTool(
        "prepare_change",
        {
          description: `Prepare a real device or runtime operation marked requireApproval, with exact toolName and args, impact, validation and conditional rollback. Platform inventory, account custody and access-state management use native permissions directly without this tool or work orders. Simulation is optional: plan.simulation may reference the actual simulation Agent namespace/name and its completed Task ID. Workspace: ${namespace}. Call the reviewed tool with identical args for human approval. Credential fields are redacted publicly; execution retains exact private arguments. Preparation never executes or approves a change.`,
          inputSchema: inputSchema(changeSchema),
          annotations: { readOnlyHint: true, destructiveHint: false },
        },
        async (args) => {
          try {
            return result(
              PrepareChangeResponseSchema,
              await prepareChange(fromJson(PrepareChangeRequestSchema, args)),
            );
          } catch (error) {
            if (!(error instanceof ChangePreparationError)) throw error;
            return { isError: true, content: [{ type: "text" as const, text: error.message }] };
          }
        },
      ),
    ]);
    tools.push([
      "delegate_coordinator",
      server.registerTool(
        "delegate_coordinator",
        {
          description:
            "Delegate an operation only to the workspace coordinator. Input is an A2A Message: use a fresh UUID messageId, ROLE_USER and text parts with four short bullets: goal, essential context, deliverable and scope. Limit delegation text to 300 Chinese characters or 150 English words; reference long evidence by task or attachment and send only new facts on follow-ups. Omit contextId for new work; reuse the returned session_id as contextId for follow-ups. Reuse the same messageId and inputs on retries. Returns the native kagent invocation result, including session_id, task_id, state and text. When input is required, report the wait and let the original task handle the response.",
          inputSchema: inputSchema(messageSchema),
          annotations: { destructiveHint: false, idempotentHint: true },
        },
        (args, context) => delegate(args, context.mcpReq.signal),
      ),
    ]);
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
          description:
            "Discover available Agents and their capabilities and readiness in the team namespace.",
          inputSchema: inputSchema(listSchema),
          annotations: { readOnlyHint: true },
        },
        async (args) => {
          const request = fromJson(ListAgentsRequestSchema, args);
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
          return result(
            CreateSessionResponseSchema,
            await clients.sessions.createSession(request, { timeoutMs: 60_000 }),
          );
        },
      ),
    ]);
    tools.push([
      "dispatch_session",
      server.registerTool(
        "dispatch_session",
        {
          description:
            "Dispatch independent background work to an existing Session without waiting for completion. Input is an official A2A Message: contextId is the session.id, messageId is a fresh random UUID, role is ROLE_USER, and parts contains the task text. Returns the accepted A2A Task; acceptance does not mean completion. Use for knowledge persistence after the main goal is verified. Use invoke_session when the main result depends on the child's answer, including knowledge retrieval.",
          inputSchema: inputSchema(messageSchema),
          annotations: { destructiveHint: false },
        },
        async (args) => {
          const message = fromJson(MessageSchema, args);
          if (
            !message.contextId ||
            !message.messageId ||
            message.role !== Role.USER ||
            message.taskId ||
            !message.parts.length
          )
            throw new Error(
              "A new background task requires a user message, messageId and Session contextId",
            );
          const { session } = await clients.sessions.getSession(
            { sessionId: message.contextId },
            { timeoutMs: 10_000 },
          );
          if (!session?.agent || !(await isEngineer(session.agent)))
            throw new Error("Dispatch only to sessions of engineers returned by list_agents");
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
          if (
            !role.tools.some(
              (binding) =>
                binding.server === "team-sessions" && binding.tools.includes("search_knowledge"),
            )
          )
            role.tools.push(
              create(ToolBindingSchema, { server: "team-sessions", tools: ["search_knowledge"] }),
            );
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
