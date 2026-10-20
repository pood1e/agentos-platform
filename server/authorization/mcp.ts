import { create } from "@bufbuild/protobuf";
import type { ServiceImpl } from "@connectrpc/connect";
import { CallToolRequestParamsSchema } from "@modelcontextprotocol/core";
import type { CallToolRequest } from "@modelcontextprotocol/server";
import {
  AuthorizationError_Code,
  type ExtMcp,
  type HeaderMutation,
  type McpRequest,
  type McpRequestResult,
  McpRequestResultSchema,
  McpResponseResultSchema,
} from "../../gen/agentgateway/dev/ext_mcp/ext_mcp_pb.js";
import type { Session } from "../../gen/kagent/api/v1alpha1/sessions_pb.js";
import { actorTokenHeader, type runtimeIdentity } from "./actor.js";

export const discoveryMethods = new Set([
  "initialize",
  "notifications/initialized",
  "ping",
  "server/discover",
  "tools/list",
]);

/** Authorizes the actual MCP call with identity resolved outside model-controlled arguments. */
export function mcpAuthorization(
  identity: ReturnType<typeof runtimeIdentity>,
  authorize: (
    session: Session,
    tool: CallToolRequest["params"],
    target: Pick<McpRequest, "serviceNames" | "metadataContext">,
  ) => Promise<Pick<McpRequestResult, "headerMutation" | "metadata">> | Promise<void>,
  discoveryHeaders?: HeaderMutation,
): Required<ServiceImpl<typeof ExtMcp>> {
  return {
    async checkRequest(request) {
      try {
        if (!discoveryMethods.has(request.method)) {
          if (request.method !== "tools/call") throw new Error("Unsupported MCP method");
          const headers = request.headers.filter(
            (header) => header.key.toLowerCase() === actorTokenHeader,
          );
          if (headers.length !== 1) throw new Error("Runtime identity required");
          const bearer = new TextDecoder("utf-8", { fatal: true }).decode(headers[0].value);
          if (!/^Bearer [^\s,]+$/.test(bearer)) throw new Error("Runtime identity required");
          const session = await identity(bearer.slice(7));
          const params = CallToolRequestParamsSchema.parse(
            JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(request.mcpRequest)),
          );
          const authorized = await authorize(session, params, {
            serviceNames: request.serviceNames,
            metadataContext: request.metadataContext,
          });
          const response = create(McpRequestResultSchema, { result: { case: "pass", value: {} } });
          return Object.assign(response, authorized);
        }
        return create(McpRequestResultSchema, {
          result: { case: "pass", value: {} },
          headerMutation: discoveryHeaders,
        });
      } catch {
        return create(McpRequestResultSchema, {
          result: {
            case: "error",
            value: {
              code: AuthorizationError_Code.PERMISSION_DENIED,
              reason: "Tool access denied",
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
