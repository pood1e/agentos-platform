import { create } from "@bufbuild/protobuf";
import { createClient, createRouterTransport } from "@connectrpc/connect";
import { fastifyConnectPlugin } from "@connectrpc/connect-fastify";
import {
  RESOURCE_MIME_TYPE,
  registerAppResource,
  registerAppTool,
} from "@modelcontextprotocol/ext-apps/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, fromJsonSchema, McpServer } from "@modelcontextprotocol/server";
import Fastify from "fastify";
import { onTestFinished, vi } from "vitest";
import { MessageSchema, Role, TaskSchema, TaskState } from "../../gen/a2a_pb.js";
import { ConsoleService } from "../../gen/agentos/console/v1/console_service_pb.js";
import { PackSchema } from "../../gen/agentos/console/v1/pack_pb.js";
import { ExecutionIdentitySchema } from "../../gen/agentos/execution/v1/identity_pb.js";
import { ActivityState } from "../../gen/agentos/execution/v1/state_pb.js";
import {
  ApprovalService,
  GovernanceConfigSchema,
} from "../../gen/agentos/governance/v1/governance_pb.js";
import { SessionSchema } from "../../gen/kagent/api/v1/sessions_pb.js";
import { executions } from "../../server/authorization/executions.js";
import { consoleService } from "../../server/console/service.js";
import { toolMetadata } from "../../server/kagent/tool-metadata.js";
import { mcpApps } from "../../server/mcp-apps/service.js";
import { workspaceContext } from "../../server/platform/access.js";
import { hitlExtension } from "../../server/read-model/decode/hitl.js";
import { environment, testBindings } from "../harness.js";
import { memoryStore } from "./execution-store.js";

export async function approvalAppsEnvironment(approvalState = ActivityState.UNOBSERVED) {
  const calls: { name: string; meta: unknown; authorization: string }[] = [];
  const provider = Fastify();
  let failure = false;
  await provider.register(fastifyConnectPlugin, {
    routes: (router) =>
      router.service(ApprovalService, {
        getApproval: async () => ({
          approval: {
            id: "change",
            state: approvalState,
            app: { tool: "show_ticket", arguments: { id: 19 } },
            link: { name: "#19", url: "https://tickets.example/19" },
          },
        }),
      }),
  });
  provider.addHook("onRequest", async (request, reply) => {
    if (
      request.headers.authorization !== "Bearer catalog" &&
      request.headers.authorization !== "Bearer human-alice" &&
      request.headers.authorization !== "Bearer human-bob"
    )
      return reply.code(401).send();
  });
  const handler = toNodeHandler(
    createMcpHandler(({ requestInfo }) => {
      const server = new McpServer({ name: "Approval fixture", version: "1.0.0" });
      registerAppResource(server, "Ticket", "ui://fixture/ticket.html", {}, async () => ({
        contents: [
          {
            uri: "ui://fixture/ticket.html",
            mimeType: RESOURCE_MIME_TYPE,
            text: "<!doctype html><title>Ticket</title>",
          },
        ],
      }));
      for (const name of ["show_ticket", "ticket_detail", "decide_ticket", "model_write"]) {
        registerAppTool(
          server,
          name,
          {
            inputSchema: fromJsonSchema({ type: "object" }),
            annotations: { readOnlyHint: ["show_ticket", "ticket_detail"].includes(name) },
            _meta: {
              ui:
                name === "show_ticket"
                  ? { resourceUri: "ui://fixture/ticket.html" }
                  : { visibility: [name === "model_write" ? "model" : "app"] },
            },
          },
          async (_args, ctx) => {
            if (failure) throw new Error("Native approval unavailable");
            calls.push({
              name,
              meta: ctx.mcpReq._meta,
              authorization: requestInfo?.headers.get("authorization") ?? "",
            });
            return {
              content: [{ type: "text", text: "Bound ticket" }],
              structuredContent: { id: 19 },
            };
          },
        );
      }
      return server;
    }),
  );
  provider.post("/", async (request, reply) => {
    reply.hijack();
    await handler(request.raw, reply.raw, request.body);
  });
  const url = await provider.listen({ host: "127.0.0.1", port: 0 });
  const question = create(MessageSchema, {
    messageId: "approval-request",
    role: Role.AGENT,
    extensions: [hitlExtension],
    metadata: {
      [hitlExtension]: {
        type: "tool_approval_request",
        tools: [{ id: "write", call_id: "call", name: "lab-cms_publish", args: {} }],
      },
    },
  });
  const task = create(TaskSchema, {
    id: "task",
    contextId: "context",
    status: { state: TaskState.INPUT_REQUIRED, message: question },
    history: [question],
  });
  const session = create(SessionSchema, {
    id: "context",
    agent: { namespace: "agentos", name: "assistant" },
  });
  const env = environment([task]);
  env.fake.load({ sessions: [session], tasks: [task] });
  await env.sync.refresh();
  const owner = create(ExecutionIdentitySchema, {
    subject: "alice",
    write: true,
    credential: { case: "accessToken", value: "alice-token" },
  });
  let caller = owner;
  const registry = executions(memoryStore(), async () => owner);
  await registry.bind(session, owner);
  const token = vi.fn(async (_environment: string, _role: string, identity?: typeof owner) =>
    identity ? `human-${identity.subject}` : "catalog",
  );
  const operations = create(GovernanceConfigSchema, {
    environments: [{ environment: { name: "lab" }, approvalUrl: url }],
  });
  const access = testBindings(env.fake);
  const metadata = toolMetadata(env.clients);
  const apps = mcpApps({
    ...env,
    access,
    metadata,
    operations,
    token,
    executions: registry,
    sandboxOrigin: "https://sandbox.example",
  });
  const service = consoleService({
    ...env,
    namespace: "agentos",
    access,
    metadata,
    operations,
    environmentToken: token,
    apps,
    executions: registry,
    roleDefaults: { modelConfig: "default", harness: "standard" },
    replaceTemplate: async (value) => env.fake.replaceTemplate(value),
    pack: create(PackSchema),
  });
  const client = createClient(
    ConsoleService,
    createRouterTransport((router) => router.service(ConsoleService, service), {
      router: { interceptors: [workspaceContext("agentos", "assistant", async () => caller)] },
    }),
  );
  onTestFinished(async () => {
    env.sync.close();
    await provider.close();
  });
  return {
    ...env,
    client,
    owner,
    token,
    calls,
    session,
    task,
    app: { taskId: task.id, origin: { case: "approvalToolId" as const, value: "write" } },
    caller: (identity: typeof owner) => {
      caller = identity;
    },
    fail: () => {
      failure = true;
    },
  };
}
