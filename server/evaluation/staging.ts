import { toJson } from "@bufbuild/protobuf";
import { createRouterTransport, type Interceptor } from "@connectrpc/connect";
import { ConsoleService } from "../../gen/agentos/console/v1/console_service_pb.js";
import { ManagementService } from "../../gen/agentos/management/v1/management_pb.js";
import type { ConsoleRoutes } from "../console/app.js";
import type { ResourceStore } from "../management/resources.js";
import { accessProfile } from "../platform/authorization.js";
import { object, text } from "../read-model/decode/messages.js";
import { configurationDraft } from "./draft.js";
import type { candidateDrafts } from "./service.js";

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

export const isConfigurationMutation = (name: string) => mutations.has(name);

export interface StagingDependencies {
  store: ResourceStore;
  workspace: string;
  catalogName: string;
  services: (
    draft: ReturnType<typeof configurationDraft>,
  ) => Pick<ConsoleRoutes, "service" | "management">;
  stage: ReturnType<typeof candidateDrafts>;
}

/** All existing configuration editors enter the same immutable candidate pipeline. */
export function configurationStaging(dependencies: StagingDependencies): Interceptor {
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
    const input = object(toJson(request.method.input, request.message));
    const subject = [
      object(input.role).name,
      object(object(object(object(input.connection).resource).value).metadata).name,
      object(object(input.item).skill).name,
      object(object(input.harness).ref).name,
      object(input.engineer).name,
      object(input.ref).name,
      input.name,
    ]
      .map(text)
      .find(Boolean);
    const created = await dependencies.stage(
      `${request.method.name}:${subject ?? ""}`,
      draft.proposals(),
      request.contextValues.get(accessProfile).subject,
    );
    response.header.set("x-agentos-candidate", created.id);
    return response;
  };
}
