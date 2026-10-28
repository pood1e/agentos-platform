import type { IncomingHttpHeaders } from "node:http";
import { CallToolRequestParamsSchema, JSONRPCMessageSchema } from "@modelcontextprotocol/core";
import { toNodeHandler } from "@modelcontextprotocol/node";
import type { FastifyInstance } from "fastify";
import { nativeHeaders } from "../kagent/context.js";
import type { sessionTools } from "./tools.js";

export async function registerTeamSessions(
  app: FastifyInstance,
  handler: ReturnType<typeof sessionTools>,
  authorize: (
    headers: IncomingHttpHeaders,
    method: string,
    tool: string,
  ) => Promise<{
    clientId: string;
    scopes: string[];
    headers: Headers;
  }>,
) {
  const nodeHandler = toNodeHandler(handler);
  app.route({
    method: ["GET", "POST", "DELETE"],
    url: "/mcp",
    handler: async (request, reply) => {
      {
        const message = JSONRPCMessageSchema.safeParse(request.body);
        const method = message.success && "method" in message.data ? message.data.method : "";
        const params =
          method === "tools/call" && message.success && "params" in message.data
            ? CallToolRequestParamsSchema.safeParse(message.data.params)
            : undefined;
        const tool = params?.success ? params.data.name : "";
        const scope = await authorize(request.headers, method, tool).catch(() => undefined);
        if (!scope) return reply.code(403).send();
        Object.assign(request.raw, {
          auth: { token: "", clientId: scope.clientId, scopes: scope.scopes },
        });
        reply.hijack();
        return nativeHeaders.run(scope.headers, () =>
          nodeHandler(request.raw, reply.raw, request.body),
        );
      }
    },
  });
}
