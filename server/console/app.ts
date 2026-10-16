import { existsSync } from "node:fs";
import type { Interceptor, ServiceImpl } from "@connectrpc/connect";
import { fastifyConnectPlugin } from "@connectrpc/connect-fastify";
import { createValidateInterceptor } from "@connectrpc/validate";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";
import { ConsoleService } from "../../gen/agentos/console/v1/console_service_pb.js";
import { EvaluationService } from "../../gen/agentos/evaluation/v1/evaluation_pb.js";
import { ManagementService } from "../../gen/agentos/management/v1/management_pb.js";
import { consoleErrors } from "./interceptor.js";

export interface ConsoleRoutes {
  service: ServiceImpl<typeof ConsoleService>;
  management?: ServiceImpl<typeof ManagementService>;
  ready: () => boolean;
  staticRoot?: string;
  /** Solution pack assets served under /pack/. */
  packRoot?: string;
  authorization?: Interceptor;
  evaluation?: ServiceImpl<typeof EvaluationService>;
  staging?: Interceptor;
}

export async function registerConsole(app: FastifyInstance, routes: ConsoleRoutes) {
  await app.register(fastifyConnectPlugin, {
    interceptors: [
      consoleErrors(app.log),
      ...(routes.authorization ? [routes.authorization] : []),
      createValidateInterceptor(),
      ...(routes.staging ? [routes.staging] : []),
    ],
    routes: (router) => {
      router.service(ConsoleService, routes.service);
      if (routes.management) router.service(ManagementService, routes.management);
      if (routes.evaluation) router.service(EvaluationService, routes.evaluation);
    },
  });
  app.get("/healthz", async () => ({ status: "ok" }));
  app.get("/readyz", async (_request, reply) =>
    routes.ready() ? { status: "ready" } : reply.code(503).send({ status: "synchronizing" }),
  );
  if (routes.packRoot)
    await app.register(fastifyStatic, {
      root: routes.packRoot,
      prefix: "/pack/",
      decorateReply: false,
    });
  if (routes.staticRoot && existsSync(routes.staticRoot)) {
    await app.register(fastifyStatic, { root: routes.staticRoot });
    // Client-side routes resolve to the single-page application.
    app.setNotFoundHandler((request, reply) =>
      request.method === "GET" && request.headers.accept?.includes("text/html")
        ? reply.sendFile("index.html")
        : reply.code(404).send(),
    );
  }
}
