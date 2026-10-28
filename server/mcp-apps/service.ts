import type { JsonObject } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { CallToolResultSchema, ReadResourceResultSchema } from "@modelcontextprotocol/core";
import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { FastifyBaseLogger } from "fastify";
import { LRUCache } from "lru-cache";
import type {
  CallAppToolRequest,
  GetAppResourceRequest,
} from "../../gen/agentos/console/v1/console_service_pb.js";
import type { Conversation } from "../../gen/agentos/console/v1/conversation_pb.js";
import type { ExecutionIdentity } from "../../gen/agentos/execution/v1/identity_pb.js";
import type { ToolCall } from "../../gen/agentos/execution/v1/task_pb.js";
import { agentRoles } from "../authorization/agent-role.js";
import { viewer, visibleGraph } from "../console/history.js";
import type { BindingView, ToolBindings } from "../governance/bindings.js";
import type { KagentClients } from "../kagent/clients.js";
import { appOnly, appResource, appVisible, type ToolMetadata } from "../kagent/tool-metadata.js";
import type { TaskGraph } from "../read-model/graph.js";
import type { TaskQueries } from "../read-model/queries.js";
import type { FullTask } from "../read-model/views/conversation.js";
import { taskRun } from "../read-model/views/run.js";
import { notFound, unavailable } from "../shared/errors.js";
import { callEnvironmentAppTool } from "./client.js";
import { projectAppViews } from "./projection.js";

interface Dependencies {
  clients: KagentClients;
  projection: TaskQueries;
  namespace: string;
  access: BindingView;
  metadata: ToolMetadata;
  sandboxOrigin: string;
  gatewayURL: string;
  log?: Pick<FastifyBaseLogger, "info">;
  invoke?: typeof callEnvironmentAppTool;
}

function resourceResult(value: unknown): JsonObject {
  const result = ReadResourceResultSchema.parse(value);
  if (result.contents.length !== 1 || result.contents[0].mimeType !== RESOURCE_MIME_TYPE)
    throw notFound("mcpApp.unavailable");
  const content = result.contents[0];
  const size =
    "text" in content
      ? Buffer.byteLength(content.text)
      : Buffer.from(content.blob, "base64").byteLength;
  if (size > 8 * 1024 * 1024)
    throw new ConnectError("MCP App resource is too large", Code.ResourceExhausted);
  return result as JsonObject;
}

export function mcpApps({
  clients,
  projection,
  namespace,
  access,
  metadata,
  sandboxOrigin,
  gatewayURL,
  log,
  invoke = callEnvironmentAppTool,
}: Dependencies) {
  const agentRole = agentRoles(clients);
  const projectionPolicy = new LRUCache<string, Promise<ToolBindings>>({ max: 1, ttl: 5_000 });
  const resources = new LRUCache<
    string,
    JsonObject,
    Parameters<KagentClients["tools"]["readMCPAppResource"]>[0]
  >({
    max: 64,
    maxSize: 32 * 1024 * 1024,
    sizeCalculation: (value) => Buffer.byteLength(JSON.stringify(value)),
    ttl: 60_000,
    fetchMethod: async (_key, _stale, { context, signal }) => {
      const response = await clients.tools.readMCPAppResource(context, {
        signal,
        timeoutMs: 15_000,
      });
      return resourceResult(response.result?.value);
    },
  });
  const denied = () => new ConnectError("MCP App tool access denied", Code.PermissionDenied);
  async function source(call: ToolCall, selectedPolicy?: ToolBindings) {
    const policy = selectedPolicy ?? (await access());
    const name = call.name;
    const target = policy
      .catalogs()
      .toSorted((a, b) => b.service.length - a.service.length)
      .find((target) => name.startsWith(`${target.service}_`));
    if (!target) return;
    const toolServers = await metadata.servers();
    const server = toolServers.find((server) => server.ref === `${namespace}/${target.server}`);
    if (!server) return;
    const tools = await metadata.tools(server);
    const unprefix = (value: string) =>
      value.startsWith(`${target.service}_`) ? value.slice(target.service.length + 1) : value;
    const tool = tools.find((tool) => unprefix(tool.name) === unprefix(name));
    if (!tool || appOnly(tool)) return;
    const uri = appResource(tool);
    return uri ? { target, server, tool, tools, uri, unprefix } : undefined;
  }
  async function original(
    request: GetAppResourceRequest | CallAppToolRequest,
    identity: ExecutionIdentity,
  ) {
    const reference = request.app;
    if (!reference?.callId) throw notFound("mcpApp.unavailable");
    const view = await visibleGraph(projection, viewer(identity), { taskId: reference.taskId });
    const entry = view?.entry(reference.taskId);
    if (!entry) throw notFound("task.notFound");
    const run = await taskRun(entry, projection.fullTask);
    const call = run?.calls.find((call) => call.id === reference.callId);
    const origin = call && (await source(call));
    if (!origin) throw notFound("mcpApp.unavailable");
    return { ...origin, call };
  }
  async function decorate(calls: ToolCall[], policy: ToolBindings) {
    await Promise.all(
      calls.map(async (call) => {
        if (!sandboxOrigin) return;
        try {
          call.uiResourceUri = (await source(call, policy))?.uri ?? "";
        } catch {
          call.uiResourceUri = "";
        }
      }),
    );
  }
  return {
    async project(view: Conversation, graph: TaskGraph, fullTask: FullTask) {
      if (!sandboxOrigin) return;
      try {
        await projectAppViews(graph, fullTask, view, async (calls) => {
          if (!calls.length) return;
          let policy = projectionPolicy.get("catalog");
          if (!policy) {
            policy = access();
            projectionPolicy.set("catalog", policy);
          }
          await decorate(calls, await policy);
        });
      } catch {
        log?.info({ component: "mcp-apps" }, "MCP App metadata unavailable");
      }
    },
    async getResource(
      request: GetAppResourceRequest,
      identity: ExecutionIdentity,
      signal: AbortSignal,
    ) {
      if (!sandboxOrigin) throw unavailable();
      const origin = await original(request, identity);
      const key = `${origin.server.ref}:${origin.uri}`;
      signal.throwIfAborted();
      // The cache owns the shared fetch; one departing viewer cannot cancel other Apps.
      const result = await resources.forceFetch(key, {
        context: { server: metadata.reference(origin.server), uri: origin.uri },
      });
      signal.throwIfAborted();
      return { result: { value: result }, sandboxOrigin };
    },
    async callTool(request: CallAppToolRequest, identity: ExecutionIdentity, signal: AbortSignal) {
      if (!sandboxOrigin) throw unavailable();
      const origin = await original(request, identity);
      const tool = origin.tools.find(
        (tool) => origin.unprefix(tool.name) === origin.unprefix(request.name),
      );
      if (!tool || !appVisible(tool)) throw denied();
      const entry = await projection.entry(request.app?.taskId ?? "");
      const { session } = await clients.sessions.getSession(
        { sessionId: entry?.contextId },
        { signal, timeoutMs: 5_000 },
      );
      if (!session) throw denied();
      const { engineer } = await agentRole(session);
      const policy = await access();
      if (!policy.permitsCall(engineer, [origin.target.service], tool.name, false)) throw denied();
      if (identity.credential.case !== "accessToken" || !identity.credential.value)
        throw new ConnectError("MCP App viewer credential required", Code.Unauthenticated);
      const audit = {
        initiator: identity.subject,
        taskId: request.app?.taskId,
        callId: request.app?.callId,
        environment: origin.target.environment,
        service: origin.target.project,
        tool: origin.unprefix(tool.name),
      };
      try {
        const result = CallToolResultSchema.parse(
          await invoke(
            gatewayURL,
            origin.target.environment,
            engineer,
            origin.target.project,
            identity.credential.value,
            { name: origin.unprefix(tool.name), arguments: request.arguments?.value },
            signal,
          ),
        );
        log?.info({ ...audit, failed: result.isError ?? false }, "MCP App tool call");
        return { result: { value: result as JsonObject } };
      } catch (error) {
        log?.info({ ...audit, failed: true }, "MCP App tool call");
        throw error;
      }
    },
  };
}

export type McpApps = ReturnType<typeof mcpApps>;
