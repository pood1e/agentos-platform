import { create, fromJson, type JsonObject, toJson } from "@bufbuild/protobuf";
import type { ServiceImpl } from "@connectrpc/connect";
import {
  AuthorizationError_Code,
  type ExtMcp,
  McpRequestResultSchema,
  McpResponseResultSchema,
} from "../../gen/agentgateway/dev/ext_mcp/ext_mcp_pb.js";
import { ListSessionsOutputSchema } from "../../gen/agentos/kagent/v1/wire_pb.js";
import { actorTokenHeader } from "../authorization/actor.js";
import type { ExecutionRuntime } from "../authorization/runtime.js";
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
  workspaces: ReadonlyMap<string, KagentClients>,
  execution?: ExecutionRuntime,
): Required<ServiceImpl<typeof ExtMcp>> {
  const scope = (metadata?: JsonObject) => {
    const workspace = text(metadata?.workspace),
      prefix = text(metadata?.agentPrefix);
    const clients = workspaces.get(workspace);
    if (!clients) throw new Error("Workspace access denied");
    return {
      workspace,
      prefix,
      clients,
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
          const actorHeaders = request.headers.filter(
            (header) => header.key.toLowerCase() === actorTokenHeader,
          );
          if (actorHeaders.length > 1) throw new Error("One signed runtime identity is required");
          const parent =
            execution && actorHeaders[0]
              ? await execution.actor({
                  [actorTokenHeader]: new TextDecoder().decode(actorHeaders[0].value),
                })
              : undefined;
          if (execution) {
            if (parent) await execution.registry.resolve(parent);
            else if (!["platform", "evaluation"].includes(text(request.metadataContext?.service)))
              throw new Error("Signed runtime identity required");
          }
          const params = object(JSON.parse(new TextDecoder().decode(request.mcpRequest)));
          if (params.name !== "invoke_session" && params.name !== "list_sessions")
            throw new Error("MCP tool is outside collaboration scope");
          if (execution && parent) await execution.authorizeTools(parent, [params.name]);
          if (params.name === "invoke_session") {
            const id = text(object(params.arguments).session_id);
            if (!id) throw new Error("Native session is required");
            const { session } = await access.clients.sessions.getSession(
              { sessionId: id },
              { timeoutMs: 10_000 },
            );
            if (
              !session?.agent ||
              !access.accepts(`${session.agent.namespace}/${session.agent.name}`)
            )
              throw new Error("Session belongs to another workspace or evaluation");
            if (execution && access.workspace === session.agent.namespace) {
              if (parent) {
                await execution.registry.delegate(parent, session);
              } else {
                const target = await execution.registry.resolve(session);
                if (target.identity.credential.case !== "service")
                  throw new Error("A service cannot invoke a user's execution");
              }
            }
          }
        }
        return create(McpRequestResultSchema, { result: { case: "pass", value: {} } });
      } catch (error) {
        return create(McpRequestResultSchema, {
          result: denied(error instanceof Error ? error.message : "Collaboration access denied"),
        });
      }
    },
    async checkResponse(request) {
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
        if (execution) {
          const bearer = text(request.metadataContext?.runtimeIdentity);
          const parent = bearer ? await execution.actor({ [actorTokenHeader]: bearer }) : undefined;
          if (parent) await execution.registry.resolve(parent);
          else if (!["platform", "evaluation"].includes(text(request.metadataContext?.service)))
            throw new Error("Signed runtime identity required");
          const allowed = [];
          for (const item of output.sessions) {
            const { session } = await access.clients.sessions.getSession(
              { sessionId: item.id },
              { timeoutMs: 5_000 },
            );
            if (!session) continue;
            try {
              if (parent) await execution.registry.delegate(parent, session);
              else if (
                (await execution.registry.resolve(session)).identity.credential.case !== "service"
              )
                continue;
              allowed.push(item);
            } catch {
              /* Foreign executions are omitted from discovery. */
            }
          }
          output.sessions = allowed;
        }
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
