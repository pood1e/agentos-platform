import {
  create,
  type DescMessage,
  fromJson,
  type JsonValue,
  type Message,
  toJson,
} from "@bufbuild/protobuf";
import { createValidator } from "@bufbuild/protovalidate";
import { createMcpHandler, fromJsonSchema, McpServer } from "@modelcontextprotocol/server";
import {
  MessageSchema,
  Role,
  SendMessageConfigurationSchema,
  SendMessageResponseSchema,
} from "../../gen/a2a_pb.js";
import { RoleDefinitionSchema, ToolBindingSchema } from "../../gen/agentos/console/v1/role_pb.js";
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
import { agentInfo, agentKey, systemRoles } from "../read-model/agents.js";
import { hitlExtension } from "../read-model/decode/hitl.js";
import { object } from "../read-model/decode/messages.js";
import { coordinatorDelegation } from "./delegate.js";

interface SchemaBundle {
  $ref: string;
  $defs: Record<string, object>;
}

const inputSchema = (bundle: SchemaBundle) =>
  fromJsonSchema<JsonValue>({
    ...bundle.$defs[bundle.$ref.slice("#/$defs/".length)],
    $defs: bundle.$defs,
  });

function result(schema: DescMessage, message: Message) {
  const output = toJson(schema, message);
  return {
    content: [{ type: "text" as const, text: JSON.stringify(output) }],
    structuredContent: object(output),
  };
}

const validator = createValidator();

/** Workspace collaboration, role drafting and shared knowledge retrieval. */
export function sessionTools(
  clients: KagentClients,
  namespace: string,
  access: BindingView,
  knowledge: Pick<ReturnType<typeof knowledgeService>, "search">,
  invoke: ReturnType<typeof nativeInvocation>,
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
  return createMcpHandler(() => {
    const server = new McpServer({ name: "team-sessions", version: manifest.version });
    server.registerTool(
      "delegate_coordinator",
      {
        description:
          "Delegate a task only to the workspace coordinator. Input is an A2A Message: use a fresh UUID messageId, ROLE_USER and text parts with the goal, language and constraints. Omit contextId for new work; reuse the returned session_id as contextId for follow-ups. Reuse the same messageId and inputs on retries. Returns the native kagent invocation result, including session_id, task_id, state and text. When input is required, report the wait and let the original task handle the response.",
        inputSchema: inputSchema(messageSchema),
        annotations: { destructiveHint: false, idempotentHint: true },
      },
      (args, context) => delegate(args, context.mcpReq.signal),
    );
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
    );
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
    );
    server.registerTool(
      "create_session",
      {
        description:
          "Create an independent conversation with a chosen Agent. Generate a fresh random UUID for requestId for each new conversation; reuse that UUID with identical inputs only for retries of that creation. Use the returned session.id with invoke_session. Create conversations only for work you choose to delegate.",
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
    );
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
    );
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
    );
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
    );
    return server;
  });
}
