import { fromJsonString } from "@bufbuild/protobuf";
import type { ConnectNodeAdapterOptions } from "@connectrpc/connect-node";
import {
  type McpRequest,
  McpRequestSchema,
} from "../../gen/agentgateway/dev/ext_mcp/ext_mcp_pb.js";
import { actorTokenHeader } from "./actor.js";

/** Native HTTP external authorization on the gateway-only guardrails listener. */
export function environmentAuthorization(
  authorize: (target: McpRequest, proof?: string) => Promise<string>,
): NonNullable<ConnectNodeAdapterOptions["fallback"]> {
  return async (request, response) => {
    if (request.url !== "/authorize/environment") {
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
      const token = await authorize(
        fromJsonString(McpRequestSchema, Buffer.concat(parts).toString("utf8")),
        proof,
      );
      response.writeHead(200, {
        authorization: `Bearer ${token}`,
        "cache-control": "no-store",
      });
    } catch {
      response.writeHead(403, { "cache-control": "no-store" });
    }
    response.end();
  };
}
