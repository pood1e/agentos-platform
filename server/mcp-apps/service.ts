import type { JsonObject } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { CallToolResultSchema, ReadResourceResultSchema } from "@modelcontextprotocol/core";
import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { FastifyBaseLogger } from "fastify";
import { LRUCache } from "lru-cache";
import type { UserIdentity } from "../../gen/agentos/authorization/v1/identity_pb.js";
import type {
  CallAppToolRequest,
  GetAppResourceRequest,
} from "../../gen/agentos/console/v1/console_service_pb.js";
import type { Conversation } from "../../gen/agentos/console/v1/conversation_pb.js";
import type { ToolCall } from "../../gen/agentos/execution/v1/task_pb.js";
import type { BindingView, ToolBindings } from "../governance/bindings.js";
import type { KagentClients } from "../kagent/clients.js";
import { nativeHeaders } from "../kagent/context.js";
import type { ToolMetadata } from "../kagent/tool-metadata.js";
import type { TaskGraph } from "../read-model/graph.js";
import type { TaskQueries } from "../read-model/queries.js";
import type { FullTask } from "../read-model/views/conversation.js";
import { notFound, unavailable } from "../shared/errors.js";
import { appAuthorization, appDenied } from "./authorization.js";
import { callAppTool } from "./client.js";
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
  invoke?: typeof callAppTool;
}

function resourceResult(value: unknown, uri: string): JsonObject {
  const result = ReadResourceResultSchema.parse(value);
  if (
    result.contents.length !== 1 ||
    result.contents[0].mimeType !== RESOURCE_MIME_TYPE ||
    result.contents[0].uri !== uri
  )
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
  invoke = callAppTool,
}: Dependencies) {
  const { source, authorize } = appAuthorization({
    clients,
    projection,
    namespace,
    access,
    metadata,
  });
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
      return resourceResult(response.result?.value, context.uri ?? "");
    },
  });
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
    async authorize(
      reference: GetAppResourceRequest["app"],
      identity: UserIdentity,
      signal: AbortSignal,
    ) {
      if (!sandboxOrigin) throw unavailable();
      const origin = await authorize(reference, identity, signal);
      return { server: origin.binding.server, tools: origin.allowedTools };
    },
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
    async getResource(request: GetAppResourceRequest, identity: UserIdentity, signal: AbortSignal) {
      if (!sandboxOrigin) throw unavailable();
      const origin = await authorize(request.app, identity, signal);
      const key = `${origin.server.ref}:${origin.uri}`;
      signal.throwIfAborted();
      // The cache owns the shared fetch; one departing viewer cannot cancel other Apps.
      const result = await resources.forceFetch(key, {
        context: { server: metadata.reference(origin.server), uri: origin.uri },
      });
      signal.throwIfAborted();
      return { result: { value: result }, sandboxOrigin };
    },
    async callTool(request: CallAppToolRequest, identity: UserIdentity, signal: AbortSignal) {
      if (!sandboxOrigin) throw unavailable();
      const origin = await authorize(request.app, identity, signal);
      const tool = origin.tools.find(
        (tool) => origin.unprefix(tool.name) === origin.unprefix(request.name),
      );
      if (!tool || !origin.allowedTools.includes(tool.name)) throw appDenied();
      const token = nativeHeaders
        .getStore()
        ?.get("authorization")
        ?.match(/^Bearer ([^\s,]+)$/)?.[1];
      if (!token)
        throw new ConnectError("MCP App viewer credential required", Code.Unauthenticated);
      const audit = {
        initiator: identity.subject,
        taskId: request.app?.taskId,
        callId: request.app?.callId,
        server: origin.binding.server,
        tool: tool.name,
      };
      try {
        const result = CallToolResultSchema.parse(
          await invoke(
            gatewayURL,
            origin.binding.server,
            origin.reference,
            token,
            { name: tool.name, arguments: request.arguments?.value },
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
