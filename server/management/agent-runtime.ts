import { create } from "@bufbuild/protobuf";
import type { SetAgentRuntimeRequest } from "../../gen/agentos/management/v1/management_pb.js";
import { ModelPurpose } from "../../gen/agentos/management/v1/management_pb.js";
import { AgentTemplateSchema } from "../../gen/kagent/api/v1/agent_templates_pb.js";
import { AgentSchema } from "../../gen/kagent/api/v1/agents_pb.js";
import type { ResourceReference } from "../../gen/kagent/api/v1/common_pb.js";
import { object, text } from "../../shared/json.js";
import { modelPurpose } from "../../shared/model-purpose.js";
import { validateAgent } from "../kagent/admission.js";
import type { KagentClients } from "../kagent/clients.js";
import { meta, resource, systemTemplates } from "../kagent/resources.js";
import { agentInfo } from "../read-model/agents.js";
import { conflict, invalid } from "../shared/errors.js";
import { localName } from "./native.js";
import type { ResourceStore } from "./resources.js";

export function agentRuntime(store: ResourceStore, clients: KagentClients, namespace: string) {
  const local = (ref: ResourceReference | undefined) => localName(ref, namespace);
  async function read(ref: ResourceReference | undefined) {
    const name = local(ref);
    const value = await store.get("agents", name);
    const agent = create(AgentSchema, { ref: { name, namespace }, resource: resource(value) });
    if (systemTemplates.has(agentInfo(agent).templateName)) throw invalid("harness.invalidAgent");
    const template = text(object(object(object(value.spec).template).ref).name);
    const agentTemplate = template
      ? create(AgentTemplateSchema, {
          ref: { namespace, name: template },
          resource: resource(await store.get("templates", template)),
        })
      : undefined;
    return { agent, agentTemplate };
  }
  async function assign(request: SetAgentRuntimeRequest) {
    const { agent, agentTemplate } = await read(request.agent);
    const value = agent.resource?.value ?? {};
    if (
      meta(value).uid !== request.expectedUid ||
      BigInt(String(meta(value).generation ?? 0)) !== request.generation ||
      (agentTemplate &&
        meta(agentTemplate.resource?.value ?? {}).resourceVersion !==
          request.templateResourceVersion)
    )
      throw conflict("configuration.conflict");
    const spec = {
      ...object(value.spec),
      harnessRef: { name: local(request.harness) },
      modelConfigRef: { name: local(request.modelConfig) },
    };
    if (
      modelPurpose(await store.get("modelConfigs", spec.modelConfigRef.name)) !==
      ModelPurpose.LANGUAGE
    )
      throw invalid("management.invalidModel");
    await validateAgent(clients, { namespace, name: local(agent.ref) }, spec);
    const saved = await store.save("agents", { ...value, spec }, false);
    return {
      agent: create(AgentSchema, { ref: agent.ref, resource: resource(saved) }),
      agentTemplate,
    };
  }
  return { read, assign };
}
