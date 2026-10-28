import { fromJsonString } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import type { ConnectNodeAdapterOptions } from "@connectrpc/connect-node";
import type { FastifyBaseLogger } from "fastify";
import {
  type McpRequest,
  McpRequestSchema,
} from "../../gen/agentgateway/dev/ext_mcp/ext_mcp_pb.js";
import { ModelAuthorizationSchema } from "../../gen/agentos/authorization/v1/workload_pb.js";
import { httpMetrics } from "../shared/telemetry.js";
import { actorTokenHeader } from "./actor.js";
import type { modelAuthorization } from "./models.js";
import { tokenRejected } from "./token-errors.js";
import type { WorkloadIdentity } from "./workloads.js";

const routes = ["/authorize/environment", "/authorize/model", "/authorize/automation"];

/** Native HTTP external authorization on the gateway-only guardrails listener. */
export function gatewayAuthorization(
  authorize: (target: McpRequest, proof?: string) => Promise<string>,
  model: ReturnType<typeof modelAuthorization>,
  workloads: WorkloadIdentity,
  options: {
    log?: Pick<FastifyBaseLogger, "warn" | "error">;
  } = {},
): NonNullable<ConnectNodeAdapterOptions["fallback"]> {
  return httpMetrics(routes, async (request, response) => {
    if (!routes.includes(request.url ?? "")) {
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
        if (size > 8192)
          throw new ConnectError("Authorization context is too large", Code.ResourceExhausted);
        parts.push(chunk);
      }
      const proof = request.headers[actorTokenHeader];
      if (Array.isArray(proof))
        throw new ConnectError("One runtime identity required", Code.Unauthenticated);
      const body = Buffer.concat(parts).toString("utf8");
      function parse<T>(decode: () => T): T {
        try {
          return decode();
        } catch {
          throw new ConnectError("Invalid authorization context", Code.InvalidArgument);
        }
      }
      if (request.url === "/authorize/environment") {
        if (!proof) await workloads.controller(request.headers, "initialize");
        const token = await authorize(
          parse(() => fromJsonString(McpRequestSchema, body)),
          proof,
        );
        response.writeHead(200, { authorization: `Bearer ${token}`, "cache-control": "no-store" });
      } else {
        if (request.url === "/authorize/model")
          await model(
            parse(() => fromJsonString(ModelAuthorizationSchema, body)),
            request.headers,
          );
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
            "cache-control": "no-store",
          });
      }
    } catch (error) {
      const code = ConnectError.from(error).code;
      const status =
        code === Code.Unauthenticated || tokenRejected(error)
          ? 401
          : [Code.PermissionDenied, Code.NotFound].includes(code)
            ? 403
            : code === Code.InvalidArgument
              ? 400
              : code === Code.ResourceExhausted
                ? 429
                : code === Code.DeadlineExceeded
                  ? 504
                  : 503;
      const fields = { code: Code[code], status, route: request.url };
      if (status >= 500) options.log?.error(fields, "Gateway authorization unavailable");
      else options.log?.warn(fields, "Gateway authorization rejected");
      response.writeHead(status, { "cache-control": "no-store" });
    }
    response.end();
  });
}
