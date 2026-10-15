import { create } from "@bufbuild/protobuf";
import type { ServiceImpl } from "@connectrpc/connect";
import {
  AuthorizationError_Code,
  type ExtMcp,
  McpRequestResultSchema,
  McpResponseResultSchema,
} from "../../gen/agentgateway/dev/ext_mcp/ext_mcp_pb.js";
import { object, text } from "../read-model/decode/messages.js";
import type { changeControl } from "./service.js";

export function changeGuardrails(
  control: ReturnType<typeof changeControl>,
): ServiceImpl<typeof ExtMcp> {
  return {
    async checkRequest(request) {
      if (request.method !== "tools/call")
        return create(McpRequestResultSchema, { result: { case: "pass", value: {} } });
      const context = request.metadataContext,
        engineer = text(context?.engineer);
      const service = request.serviceNames[0] ?? "";
      try {
        if (!engineer || !service) throw new Error("Missing authenticated environment identity");
        const params = object(JSON.parse(new TextDecoder().decode(request.mcpRequest)));
        const changeId = await control.authorize(
          engineer,
          `${service}_${text(params.name)}`,
          object(params.arguments),
        );
        return create(McpRequestResultSchema, {
          result: { case: "pass", value: {} },
          metadata: changeId ? { changeId } : {},
        });
      } catch (error) {
        return create(McpRequestResultSchema, {
          result: {
            case: "error",
            value: {
              code: AuthorizationError_Code.PERMISSION_DENIED,
              reason: error instanceof Error ? error.message : "Change authorization failed",
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
