import { createHash, timingSafeEqual } from "node:crypto";
import { toNodeHandler } from "@modelcontextprotocol/node";
import type { FastifyInstance } from "fastify";
import type { sessionTools } from "./tools.js";

export async function registerTeamSessions(
  app: FastifyInstance,
  handler: ReturnType<typeof sessionTools>,
  token: string,
  ready: () => boolean,
) {
  if (!token) throw new Error("AGENTOS_MCP_TOKEN is required");
  const digest = (value: string) => createHash("sha256").update(value).digest();
  const expected = digest(`Bearer ${token}`);
  const nodeHandler = toNodeHandler(handler);
  app.get("/healthz", async () => ({ status: "ok" }));
  app.get("/readyz", async (_request, reply) =>
    ready() ? { status: "ready" } : reply.code(503).send({ status: "synchronizing" }),
  );
  app.route({
    method: ["GET", "POST", "DELETE"],
    url: "/mcp",
    preHandler: async (request, reply) => {
      if (!timingSafeEqual(digest(request.headers.authorization ?? ""), expected))
        return reply.code(401).send();
    },
    handler: async (request, reply) => {
      reply.hijack();
      await nodeHandler(request.raw, reply.raw, request.body);
    },
  });
}
