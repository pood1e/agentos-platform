import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type ServiceImpl } from "@connectrpc/connect";
import {
  CallToolRequestParamsSchema,
  ReadResourceRequestParamsSchema,
} from "@modelcontextprotocol/core";
import type { CallToolRequest } from "@modelcontextprotocol/server";
import {
  AuthorizationError_Code,
  type ExtMcp,
  type McpRequest,
  type McpRequestResult,
  McpRequestResultSchema,
  McpResponseResultSchema,
} from "../../gen/agentgateway/dev/ext_mcp/ext_mcp_pb.js";
import type { Session } from "../../gen/kagent/api/v1/sessions_pb.js";
import { actorTokenHeader, type runtimeIdentity } from "./actor.js";

export const discoveryMethods = new Set([
  "initialize",
  "notifications/initialized",
  "ping",
  "server/discover",
  "tools/list",
  "resources/read",
]);

function context<T>(parse: () => T): T {
  try {
    return parse();
  } catch {
    throw new ConnectError("Invalid MCP authorization context", Code.InvalidArgument);
  }
}

/** Authorizes the actual MCP call with identity resolved outside model-controlled arguments. */
export function mcpAuthorization(
  identity: ReturnType<typeof runtimeIdentity>,
  authorize: (
    session: Session,
    tool: CallToolRequest["params"],
    target: Pick<McpRequest, "serviceNames" | "metadataContext">,
  ) => Promise<Pick<McpRequestResult, "headerMutation" | "metadata">> | Promise<void>,
  discover?: (
    session: Session | undefined,
    target: McpRequest,
  ) => Promise<Pick<McpRequestResult, "headerMutation" | "metadata">>,
): Required<ServiceImpl<typeof ExtMcp>> {
  return {
    async checkRequest(request) {
      try {
        const headers = request.headers.filter(
          (header) => header.key.toLowerCase() === actorTokenHeader,
        );
        if (headers.length > 1)
          throw new ConnectError("One runtime identity required", Code.Unauthenticated);
        let session: Session | undefined;
        if (headers.length) {
          const bearer = new TextDecoder("utf-8", { fatal: true }).decode(headers[0].value);
          if (!/^Bearer [^\s,]+$/.test(bearer))
            throw new ConnectError("Runtime identity required", Code.Unauthenticated);
          session = await identity(bearer.slice(7));
        }
        if (request.method === "resources/read") {
          const params = context(() =>
            ReadResourceRequestParamsSchema.parse(
              JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(request.mcpRequest)),
            ),
          );
          if (!params.uri.startsWith("ui://"))
            throw new ConnectError("Only MCP App resources can be read", Code.PermissionDenied);
        }
        if (!discoveryMethods.has(request.method)) {
          if (request.method !== "tools/call" || !session)
            throw new ConnectError("Authenticated tool call required", Code.PermissionDenied);
          const params = context(() =>
            CallToolRequestParamsSchema.parse(
              JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(request.mcpRequest)),
            ),
          );
          const authorized = await authorize(session, params, {
            serviceNames: request.serviceNames,
            metadataContext: request.metadataContext,
          });
          const response = create(McpRequestResultSchema, { result: { case: "pass", value: {} } });
          return Object.assign(response, authorized);
        }
        const response = create(McpRequestResultSchema, { result: { case: "pass", value: {} } });
        return Object.assign(response, await discover?.(session, request));
      } catch (error) {
        const code = ConnectError.from(error).code;
        const denied = [Code.Unauthenticated, Code.PermissionDenied, Code.NotFound].includes(code);
        return create(McpRequestResultSchema, {
          result: {
            case: "error",
            value: {
              code: denied
                ? AuthorizationError_Code.PERMISSION_DENIED
                : code === Code.InvalidArgument
                  ? AuthorizationError_Code.INVALID
                  : code === Code.ResourceExhausted
                    ? AuthorizationError_Code.RESOURCE_EXHAUSTED
                    : AuthorizationError_Code.UNKNOWN,
              reason: denied
                ? "Tool access denied"
                : code === Code.InvalidArgument
                  ? "Invalid MCP authorization context"
                  : "Tool authorization unavailable",
            },
          },
        });
      }
    },
    checkResponse() {
      return create(McpResponseResultSchema, { result: { case: "pass", value: {} } });
    },
  };
}
