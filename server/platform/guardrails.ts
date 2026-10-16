import { create, fromJson, type JsonObject, toJson } from "@bufbuild/protobuf";
import type { ServiceImpl } from "@connectrpc/connect";
import {
  AuthorizationError_Code,
  type ExtMcp,
  McpRequestResultSchema,
  McpResponseResultSchema,
} from "../../gen/agentgateway/dev/ext_mcp/ext_mcp_pb.js";
import { ListSessionsOutputSchema } from "../../gen/agentos/kagent/v1/wire_pb.js";
import type { KagentClients } from "../kagent/clients.js";
import { object, text } from "../read-model/decode/messages.js";

const methods = new Set([
  "initialize",
  "notifications/initialized",
  "notifications/cancelled",
  "ping",
  "server/discover",
  "tools/list",
  "tools/call",
]);
const denied = (reason: string) => ({
  case: "error" as const,
  value: { code: AuthorizationError_Code.PERMISSION_DENIED, reason },
});

/** Agentgateway supplies verified key metadata; native sessions remain in their workspace. */
export function collaborationGuardrails(
  clients: KagentClients,
  workspaces: ReadonlySet<string>,
): ServiceImpl<typeof ExtMcp> {
  const scope = (metadata?: JsonObject) => {
    const workspace = text(metadata?.workspace),
      prefix = text(metadata?.agentPrefix);
    if (!workspaces.has(workspace)) throw new Error("Workspace access denied");
    return {
      workspace,
      prefix,
      accepts: (agent: string) => agent.startsWith(`${workspace}/${prefix}`),
    };
  };
  return {
    async checkRequest(request) {
      try {
        const access = scope(request.metadataContext);
        if (!methods.has(request.method))
          throw new Error("MCP method is outside collaboration scope");
        if (request.method === "tools/call") {
          const params = object(JSON.parse(new TextDecoder().decode(request.mcpRequest)));
          if (params.name !== "invoke_session" && params.name !== "list_sessions")
            throw new Error("MCP tool is outside collaboration scope");
          if (params.name === "invoke_session") {
            const id = text(object(params.arguments).session_id);
            if (!id) throw new Error("Native session is required");
            const { session } = await clients.sessions.getSession(
              { sessionId: id },
              { timeoutMs: 10_000 },
            );
            if (
              !session?.agent ||
              !access.accepts(`${session.agent.namespace}/${session.agent.name}`)
            )
              throw new Error("Session belongs to another workspace or evaluation");
          }
        }
        return create(McpRequestResultSchema, { result: { case: "pass", value: {} } });
      } catch (error) {
        return create(McpRequestResultSchema, {
          result: denied(error instanceof Error ? error.message : "Collaboration access denied"),
        });
      }
    },
    checkResponse(request) {
      try {
        const access = scope(request.metadataContext);
        if (
          request.method !== "tools/call" ||
          request.metadataContext?.toolName !== "list_sessions"
        )
          return create(McpResponseResultSchema, { result: { case: "pass", value: {} } });
        const result = object(JSON.parse(new TextDecoder().decode(request.mcpResponse)));
        if (!result.structuredContent) throw new Error("Native session list is incomplete");
        const output = fromJson(ListSessionsOutputSchema, result.structuredContent);
        output.sessions = output.sessions.filter((session) => access.accepts(session.agent));
        result.structuredContent = toJson(ListSessionsOutputSchema, output, {
          useProtoFieldName: true,
        });
        result.content = [
          {
            type: "text",
            text:
              output.sessions.map((session) => `${session.id} (${session.agent})`).join("\n") ||
              "No ready Sessions found.",
          },
        ];
        return create(McpResponseResultSchema, {
          result: { case: "mutated", value: new TextEncoder().encode(JSON.stringify(result)) },
        });
      } catch (error) {
        return create(McpResponseResultSchema, {
          result: denied(error instanceof Error ? error.message : "Session listing denied"),
        });
      }
    },
  };
}
