import { fromJsonString } from "@bufbuild/protobuf";
import type { ConnectNodeAdapterOptions } from "@connectrpc/connect-node";
import {
  type McpRequest,
  McpRequestSchema,
} from "../../gen/agentgateway/dev/ext_mcp/ext_mcp_pb.js";
import { ModelAuthorizationSchema } from "../../gen/agentos/authorization/v1/workload_pb.js";
import { actorTokenHeader } from "./actor.js";
import type { modelAuthorization } from "./models.js";
import type { WorkloadIdentity } from "./workloads.js";

/** Native HTTP external authorization on the gateway-only guardrails listener. */
export function gatewayAuthorization(
  authorize: (target: McpRequest, proof?: string) => Promise<string>,
  model: ReturnType<typeof modelAuthorization>,
  workloads: WorkloadIdentity,
): NonNullable<ConnectNodeAdapterOptions["fallback"]> {
  return async (request, response) => {
    if (
      !["/authorize/environment", "/authorize/model", "/authorize/automation"].includes(
        request.url ?? "",
      )
    ) {
      response.writeHead(404);
      response.end();
      return;
    }
    try {
      const parts: Buffer[] = [];
      let size = 0;
      for await (const part of request) {
        const chunk = Buffer.from(part);
        size += chunk.length;
        if (size > 8192) throw new Error("Authorization context is too large");
        parts.push(chunk);
      }
      const proof = request.headers[actorTokenHeader];
      if (Array.isArray(proof)) throw new Error("One runtime identity required");
      const body = Buffer.concat(parts).toString("utf8");
      if (request.url === "/authorize/environment") {
        const token = await authorize(fromJsonString(McpRequestSchema, body), proof);
        response.writeHead(200, { authorization: `Bearer ${token}`, "cache-control": "no-store" });
      } else {
        if (request.url === "/authorize/model")
          await model(fromJsonString(ModelAuthorizationSchema, body), request.headers);
        else {
          await workloads.automation(request.headers);
          response.writeHead(200, {
            authorization: request.headers.authorization ?? "",
            "cache-control": "no-store",
          });
        }
        if (request.url === "/authorize/model")
          response.writeHead(200, {
            authorization: "",
            [actorTokenHeader]: "",
            "cache-control": "no-store",
          });
      }
    } catch {
      response.writeHead(403, { "cache-control": "no-store" });
    }
    response.end();
  };
}
