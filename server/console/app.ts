import type { Interceptor, ServiceImpl } from "@connectrpc/connect";
import { fastifyConnectPlugin } from "@connectrpc/connect-fastify";
import { createValidateInterceptor } from "@connectrpc/validate";
import type { FastifyInstance } from "fastify";
import { ConsoleService } from "../../gen/agentos/console/v1/console_service_pb.js";
import { ManagementService } from "../../gen/agentos/management/v1/management_pb.js";
import { consoleErrors } from "./interceptor.js";

export interface ConsoleRoutes {
  service: ServiceImpl<typeof ConsoleService>;
  management?: ServiceImpl<typeof ManagementService>;
  context?: Interceptor;
}

export async function registerConsole(app: FastifyInstance, routes: ConsoleRoutes) {
  await app.register(fastifyConnectPlugin, {
    interceptors: [
      consoleErrors(app.log),
      ...(routes.context ? [routes.context] : []),
      createValidateInterceptor(),
    ],
    routes: (router) => {
      router.service(ConsoleService, routes.service, { writeMaxBytes: 17 * 1024 * 1024 });
      if (routes.management) router.service(ManagementService, routes.management);
    },
  });
}
