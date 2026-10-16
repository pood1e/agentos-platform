import { createClient, createRouterTransport, type Interceptor } from "@connectrpc/connect";
import { ConsoleService } from "../../gen/agentos/console/v1/console_service_pb.js";
import { EvaluationService } from "../../gen/agentos/evaluation/v1/evaluation_pb.js";
import { ManagementService } from "../../gen/agentos/management/v1/management_pb.js";
import type { ConsoleRoutes } from "../console/app.js";
import type { KagentClients } from "../kagent/clients.js";
import type { ResourceStore } from "../management/resources.js";
import { configurationDraft } from "./draft.js";

const mutations = new Set([
  "CreateRole",
  "UpdateRole",
  "SaveConnection",
  "DeleteConnection",
  "SaveSkill",
  "DeleteSkill",
  "SaveHarness",
  "DeleteHarness",
  "SetEngineerRuntime",
]);

export interface StagingDependencies {
  store: ResourceStore;
  clients: KagentClients;
  workspace: string;
  catalogName: string;
  services: (
    draft: ReturnType<typeof configurationDraft>,
  ) => Pick<ConsoleRoutes, "service" | "management">;
  evaluation: NonNullable<ConsoleRoutes["evaluation"]>;
}

/** All existing configuration editors enter the same immutable candidate pipeline. */
export function configurationStaging(dependencies: StagingDependencies): Interceptor {
  const evaluation = createClient(
    EvaluationService,
    createRouterTransport((router) => router.service(EvaluationService, dependencies.evaluation)),
  );
  return (next) => async (request) => {
    if (request.stream || !mutations.has(request.method.name)) return next(request);
    const draft = configurationDraft(
      dependencies.store,
      dependencies.workspace,
      dependencies.catalogName,
    );
    const services = dependencies.services(draft);
    const preview = createRouterTransport((router) => {
      router.service(ConsoleService, services.service);
      if (services.management) router.service(ManagementService, services.management);
    });
    const response = await preview.unary(
      request.method,
      request.signal,
      undefined,
      request.header,
      request.message,
      request.contextValues,
    );
    const created = await evaluation.createCandidate(
      {
        name: request.method.name,
        proposals: draft.proposals(),
      },
      { contextValues: request.contextValues, signal: request.signal },
    );
    response.header.set("x-agentos-candidate", created.candidate?.id ?? "");
    return response;
  };
}
