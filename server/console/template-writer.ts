import { create, type JsonObject } from "@bufbuild/protobuf";
import { Code } from "@connectrpc/connect";
import { ApiException, CustomObjectsApi, type KubeConfig } from "@kubernetes/client-node";
import {
  type AgentTemplate,
  AgentTemplateSchema,
} from "../../gen/kagent/api/v1/agent_templates_pb.js";
import { userResource } from "../management/native.js";
import { conflict, fail, invalid } from "../shared/errors.js";

export type TemplateWriter = (template: AgentTemplate) => Promise<AgentTemplate>;

/** kagent alpha11 drops incoming resourceVersion; replace natively to retain atomic concurrency. */
export function templateWriter(config: KubeConfig): TemplateWriter {
  const api = config.makeApiClient(CustomObjectsApi);
  return async (template) => {
    if (!template.ref || !template.resource?.value) throw invalid("configuration.invalidRole");
    try {
      const value: JsonObject = await api.replaceNamespacedCustomObject({
        group: "api.kagent.dev",
        version: "v1alpha3",
        plural: "agenttemplates",
        namespace: template.ref.namespace,
        name: template.ref.name,
        body: userResource(template.resource.value),
        fieldManager: "agentos-users",
        fieldValidation: "Strict",
      });
      return create(AgentTemplateSchema, {
        ref: template.ref,
        resource: { apiVersion: template.resource.apiVersion, kind: "AgentTemplate", value },
      });
    } catch (error) {
      if (error instanceof ApiException) {
        if (error.code === 409) throw conflict("configuration.conflict");
        if (error.code === 400 || error.code === 422) throw invalid("configuration.invalidRole");
        if (error.code === 404) throw fail(Code.NotFound, "configuration.missingRole");
      }
      throw fail(Code.Unavailable, "configuration.saveFailed", error);
    }
  };
}
