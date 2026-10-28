import type { Interceptor, ServiceImpl } from "@connectrpc/connect";
import { fastifyConnectPlugin } from "@connectrpc/connect-fastify";
import { createValidateInterceptor } from "@connectrpc/validate";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";
import { AutomationService } from "../../gen/agentos/automation/v1/service_pb.js";
import { ConsoleService } from "../../gen/agentos/console/v1/console_service_pb.js";
import { ManagementService } from "../../gen/agentos/management/v1/management_pb.js";
import { consoleErrors } from "./interceptor.js";

export interface ConsoleRoutes {
  service: ServiceImpl<typeof ConsoleService>;
  management?: ServiceImpl<typeof ManagementService>;
  /** Solution pack assets served under /pack/. */
  packRoot?: string;
  context?: Interceptor;
  automation?: ServiceImpl<typeof AutomationService>;
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
      if (routes.automation) router.service(AutomationService, routes.automation);
    },
  });
  if (routes.packRoot)
    await app.register(fastifyStatic, {
      root: routes.packRoot,
      prefix: "/pack/",
    });
}
