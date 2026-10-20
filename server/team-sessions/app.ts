import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { JSONRPCMessageSchema } from "@modelcontextprotocol/core";
import { toNodeHandler } from "@modelcontextprotocol/node";
import type { FastifyInstance } from "fastify";
import type { sessionTools } from "./tools.js";

export async function registerTeamSessions(
  app: FastifyInstance,
  handler: ReturnType<typeof sessionTools>,
  token: string,
  authorize?: (
    role: string,
    headers: IncomingHttpHeaders,
    method: string,
  ) => Promise<{
    scopes: string[];
    handler?: ReturnType<typeof sessionTools>;
  }>,
) {
  if (!token) throw new Error("AGENTOS_MCP_TOKEN is required");
  const digest = (value: string) => createHash("sha256").update(value).digest();
  const expected = digest(`Bearer ${token}`);
  const nodeHandler = toNodeHandler(handler);
  app.route({
    method: ["GET", "POST", "DELETE"],
    url: "/mcp",
    preHandler: async (request, reply) => {
      if (!timingSafeEqual(digest(request.headers.authorization ?? ""), expected))
        return reply.code(401).send();
    },
    handler: async (request, reply) => {
      if (authorize) {
        const role = request.headers["x-agentos-role"];
        if (typeof role !== "string") return reply.code(403).send();
        const message = JSONRPCMessageSchema.safeParse(request.body);
        const method = message.success && "method" in message.data ? message.data.method : "";
        const scope = await authorize(role, request.headers, method).catch(() => undefined);
        if (!scope) return reply.code(403).send();
        Object.assign(request.raw, { auth: { token: "", clientId: role, scopes: scope.scopes } });
        if (scope.handler) {
          reply.hijack();
          return toNodeHandler(scope.handler)(request.raw, reply.raw, request.body);
        }
      }
      reply.hijack();
      await nodeHandler(request.raw, reply.raw, request.body);
    },
  });
}
