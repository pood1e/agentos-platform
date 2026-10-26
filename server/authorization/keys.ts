import Fastify, { type FastifyInstance, LogController } from "fastify";
import type { JSONWebKeySet } from "jose";

/** Agentgateway's controller fetches remote keys over HTTP/1.1 on a private listener. */
export function actorKeyServer(
  app: FastifyInstance,
  keys: () => Promise<JSONWebKeySet | undefined>,
) {
  const server = Fastify({
    loggerInstance: app.log,
    logController: new LogController({ disableRequestLogging: true }),
  });
  server.all("/keys/actor", async (request, reply) => {
    if (request.method !== "GET") return reply.code(405).header("allow", "GET").send();
    try {
      const current = await keys();
      if (!current) return reply.code(503).header("cache-control", "no-store").send();
      return reply
        .type("application/jwk-set+json")
        .header("cache-control", "no-store")
        .send(current);
    } catch (error) {
      app.log.error({ err: error }, "Actor signing keys unavailable");
      return reply.code(503).header("cache-control", "no-store").send();
    }
  });
  app.addHook("preClose", async () => {
    await server.close();
  });
  return server;
}
