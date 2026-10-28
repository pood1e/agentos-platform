import type { FastifyInstance } from "fastify";

/** Liveness stays independent of dependencies; readiness admits traffic once they are available. */
export function registerHealth(app: FastifyInstance, ready: () => boolean | Promise<boolean>) {
  app.get("/healthz", async () => ({ status: "ok" }));
  app.get("/readyz", async (_request, reply) =>
    (await ready()) ? { status: "ready" } : reply.code(503).send({ status: "unavailable" }),
  );
}
