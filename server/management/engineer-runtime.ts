import { create, type JsonObject } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import type { SetEngineerRuntimeRequest } from "../../gen/agentos/management/v1/management_pb.js";
import { AgentTemplateSchema } from "../../gen/kagent/api/v1/agent_templates_pb.js";
import { AgentSchema } from "../../gen/kagent/api/v1/agents_pb.js";
import type { ResourceReference } from "../../gen/kagent/api/v1/common_pb.js";
import { ModelConfigSchema } from "../../gen/kagent/api/v1/models_pb.js";
import { harnessModelIssue } from "../../shared/harness-model.js";
import type { KagentClients } from "../kagent/clients.js";
import { validateHarness } from "../kagent/harness.js";
import { agentInfo, systemRoles } from "../read-model/agents.js";
import { object, text } from "../read-model/decode/messages.js";
import { conflict, invalid, precondition } from "../shared/errors.js";
import { asHarness } from "./harnesses.js";
import { meta, resource } from "./native.js";
import type { ResourceStore } from "./resources.js";

export function engineerRuntime(store: ResourceStore, clients: KagentClients, namespace: string) {
  function local(ref: ResourceReference | undefined) {
    if (!ref?.name || (ref.namespace && ref.namespace !== namespace))
      throw invalid("harness.invalidReference");
    return ref.name;
  }
  async function read(ref: ResourceReference | undefined) {
    const name = local(ref);
    const value = await store.get("agents", name);
    const agent = create(AgentSchema, { ref: { name, namespace }, resource: resource(value) });
    if (systemRoles.has(agentInfo(agent).role)) throw invalid("harness.invalidEngineer");
    const templateName = text(object(object(object(value.spec).template).ref).name);
    const agentTemplate = templateName
      ? create(AgentTemplateSchema, {
          ref: { namespace, name: templateName },
          resource: resource(await store.get("templates", templateName)),
        })
      : undefined;
    return { agent, agentTemplate };
  }
  async function assign(request: SetEngineerRuntimeRequest) {
    const { agent, agentTemplate } = await read(request.engineer);
    const value = agent.resource?.value ?? {};
    const original = agentTemplate?.resource?.value;
    const template = object(original?.spec ?? object(object(value.spec).template).inline);
    function unchanged(value: JsonObject) {
      if (
        meta(value).uid !== request.expectedUid ||
        BigInt(String(meta(value).generation ?? 0)) !== request.generation
      )
        throw conflict("configuration.conflict");
    }
    unchanged(value);
    if (original && meta(original).resourceVersion !== request.templateResourceVersion)
      throw conflict("configuration.conflict");
    const harnessName = local(request.harness);
    const modelName = local(request.modelConfig);
    const [harness, model, { toolServers }] = await Promise.all([
      store.get("harnesses", harnessName),
      store.get("modelConfigs", modelName),
      clients.tools.listToolServers({}, { timeoutMs: 10_000 }),
    ]);
    const updatedTemplate = { ...template, modelConfig: { name: modelName } };
    validateHarness(
      asHarness(harness),
      create(ModelConfigSchema, {
        ref: { name: modelName, namespace },
        resource: resource(model),
      }),
      updatedTemplate,
      toolServers,
    );
    const modelChanged = object(template.modelConfig).name !== modelName;
    if (original && modelChanged) {
      const siblings = (await store.list("agents")).filter(
        (item) =>
          meta(item).name !== agent.ref?.name &&
          object(object(object(item.spec).template).ref).name === agentTemplate?.ref?.name,
      );
      for (const sibling of siblings) {
        const spec = object(sibling.spec);
        const siblingHarness = asHarness(
          await store.get("harnesses", text(object(spec.harnessRef).name)),
        );
        if (harnessModelIssue(siblingHarness.runtime, object(model.spec)))
          throw invalid("harness.sharedModel");
      }
    }
    let savedTemplate = original;
    if (original && modelChanged)
      savedTemplate = await store.save("templates", { ...original, spec: updatedTemplate }, false);
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const current = await store.get("agents", local(agent.ref));
        unchanged(current);
        if (savedTemplate) {
          const latest = await store.get("templates", text(meta(savedTemplate).name));
          if (meta(latest).resourceVersion !== meta(savedTemplate).resourceVersion)
            throw conflict("configuration.conflict");
        }
        const spec: JsonObject = { ...object(current.spec), harnessRef: { name: harnessName } };
        if (!original) spec.template = { inline: updatedTemplate };
        try {
          const saved = await store.save("agents", { ...current, spec }, false);
          return {
            agent: create(AgentSchema, { ref: agent.ref, resource: resource(saved) }),
            agentTemplate: savedTemplate
              ? create(AgentTemplateSchema, {
                  ref: agentTemplate?.ref,
                  resource: resource(savedTemplate),
                })
              : undefined,
          };
        } catch (error) {
          if (!(error instanceof ConnectError) || error.code !== Code.Aborted || attempt === 2)
            throw error;
        }
      }
      throw conflict("configuration.conflict");
    } catch (error) {
      // Kubernetes has no multi-resource transaction; compensate only our versioned model edit.
      if (original && savedTemplate && modelChanged) {
        try {
          await store.save("templates", { ...savedTemplate, spec: original.spec }, false);
        } catch {
          throw precondition("harness.partialSave");
        }
      }
      throw error;
    }
  }
  return { read, assign };
}
