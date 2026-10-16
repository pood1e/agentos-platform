import { isDeepStrictEqual } from "node:util";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import type { RoleDefinition } from "../../gen/agentos/console/v1/role_pb.js";
import { ErrorInfoSchema } from "../../gen/google/rpc/error_details_pb.js";
import { AgentTemplateSchema } from "../../gen/kagent/api/v1alpha1/agent_templates_pb.js";
import {
  type ResourceReference,
  ResourceReferenceSchema,
} from "../../gen/kagent/api/v1alpha1/common_pb.js";
import { engineerTools } from "../kagent/builtin-tools.js";
import type { KagentClients } from "../kagent/clients.js";
import { validateHarness } from "../kagent/harness.js";
import type { BindingView } from "../operations/bindings.js";
import { systemRoles } from "../read-model/agents.js";
import { object } from "../read-model/decode/messages.js";
import { conflict, fail, invalid, notFound } from "../shared/errors.js";
import { apiVersion, displayNameKey, roleDefinition, templateSpec } from "./role-template.js";
import type { TemplateWriter } from "./template-writer.js";

export interface RoleDefaults {
  modelConfig: string;
  harness: string;
}

const read = { timeoutMs: 10_000 };
const write = { timeoutMs: 30_000 };

function saveFailed(error: unknown): ConnectError {
  if (error instanceof ConnectError) {
    if (error.findDetails(ErrorInfoSchema).some((detail) => detail.domain === "agentos.console"))
      return error;
    if (error.code === Code.AlreadyExists) return conflict("configuration.roleExists");
    if (error.code === Code.InvalidArgument) return invalid("configuration.invalidRole");
  }
  return fail(Code.Unavailable, "configuration.saveFailed", error);
}

export function roleCommands(
  clients: KagentClients,
  namespace: string,
  access: BindingView,
  defaults: RoleDefaults,
  replaceTemplate: TemplateWriter,
  platformTools: (
    role: string,
    tools: RoleDefinition["tools"],
  ) => Promise<RoleDefinition["tools"]> = async (_role, tools) => tools,
) {
  async function catalog() {
    const [templates, tools, models] = await Promise.all([
      clients.templates.listAgentTemplates({ namespace }, read),
      clients.tools.listToolServers({}, read),
      clients.models.listModelConfigs({}, read),
    ]).catch((error: unknown) => {
      throw fail(Code.Unavailable, "configuration.unavailable", error);
    });
    return {
      modelConfigs: models.modelConfigs.filter(
        (item) => item.ref?.namespace === namespace && item.ref.name !== "knowledge-embedding",
      ),
      templates: templates.agentTemplates.filter((item) => !systemRoles.has(item.ref?.name ?? "")),
      servers: tools.toolServers.filter((server) => server.ref.startsWith(`${namespace}/`)),
    };
  }

  async function checked(role: RoleDefinition, selectedHarness?: ResourceReference) {
    if (systemRoles.has(role.name)) throw invalid("configuration.invalidRole");
    const current = await catalog();
    if (
      role.modelConfig &&
      ((role.modelConfig.namespace && role.modelConfig.namespace !== namespace) ||
        !current.modelConfigs.some((model) => model.ref?.name === role.modelConfig?.name))
    )
      throw invalid("management.invalidModel");
    const tools = (await access()).bindings(role.name, role.tools, current.servers, true);
    if (!tools) throw invalid("configuration.invalidTools");
    const [{ agents }, { harnesses }] = await Promise.all([
      clients.agents.listAgents({ namespace }, read),
      clients.harnesses.listHarnesses({ namespace }, read),
    ]);
    const assignments = selectedHarness
      ? [selectedHarness]
      : agents
          .filter(
            (agent) => object(object(agent.resource?.value?.spec).templateRef).name === role.name,
          )
          .map((agent) => object(object(agent.resource?.value?.spec).harnessRef));
    for (const assignment of assignments) {
      if (assignment.namespace && assignment.namespace !== namespace)
        throw invalid("harness.invalidReference");
      const harness = harnesses.find((item) => item.ref?.name === assignment.name);
      if (!harness) throw invalid("harness.invalidReference");
      validateHarness(
        harness,
        current.modelConfigs.find(
          (item) => item.ref?.name === (role.modelConfig?.name || defaults.modelConfig),
        ),
        templateSpec({ ...role, tools }, {}),
        current.servers,
      );
    }
    return { ...role, tools: await platformTools(role.name, tools) };
  }

  async function configuration() {
    const [{ templates, servers, modelConfigs }, { agents }, { harnesses }] = await Promise.all([
      catalog(),
      clients.agents.listAgents({ namespace }, read),
      clients.harnesses.listHarnesses({ namespace }, read),
    ]).catch((error: unknown) => {
      throw fail(Code.Unavailable, "configuration.unavailable", error);
    });
    return {
      roles: templates.map(roleDefinition),
      toolServers: servers,
      modelConfigs,
      engineerTools: engineerTools(agents, templates, harnesses),
      agents: agents.filter((agent) => !systemRoles.has(agent.ref?.name ?? "")),
      harnesses,
      defaultHarness: { namespace, name: defaults.harness },
    };
  }

  async function explain(engineer: string) {
    const [{ servers }, view] = await Promise.all([catalog(), access()]);
    return { requirements: view.requirements(engineer, servers) };
  }

  async function createRole(draft: RoleDefinition, harness?: ResourceReference) {
    const displayName = draft.displayName.trim();
    if (!displayName) throw invalid("configuration.invalidRole");
    const selectedHarness =
      harness ?? create(ResourceReferenceSchema, { namespace, name: defaults.harness });
    const role = await checked(draft, selectedHarness);
    const ref = { namespace, name: role.name };
    const annotations = { [displayNameKey]: displayName };
    try {
      const { agentTemplate } = await clients.templates.createAgentTemplate(
        {
          ref,
          resource: {
            apiVersion,
            kind: "AgentTemplate",
            value: {
              apiVersion,
              kind: "AgentTemplate",
              metadata: { name: role.name, namespace, annotations },
              spec: templateSpec(role, { modelConfig: { name: defaults.modelConfig } }),
            },
          },
        },
        write,
      );
      try {
        await clients.agents.createAgent(
          {
            ref,
            resource: {
              apiVersion,
              kind: "Agent",
              value: {
                apiVersion,
                kind: "Agent",
                metadata: {
                  name: role.name,
                  namespace,
                  labels: { "agentos.dev/role": role.name },
                  annotations: { ...annotations, "agentos.dev/description": role.description },
                },
                spec: {
                  templateRef: { name: role.name },
                  harnessRef: { name: selectedHarness.name },
                },
              },
            },
          },
          write,
        );
      } catch (error) {
        await clients.templates.deleteAgentTemplate({ ref }, read).catch(() => {});
        throw error;
      }
      if (!agentTemplate) throw fail(Code.Unavailable, "configuration.saveFailed");
      return { role: roleDefinition(agentTemplate) };
    } catch (error) {
      throw saveFailed(error);
    }
  }

  async function updateRole(draft: RoleDefinition) {
    const ref = { namespace, name: draft.name };
    const current = systemRoles.has(draft.name)
      ? undefined
      : await clients.templates
          .getAgentTemplate({ ref }, read)
          .then((response) => response.agentTemplate)
          .catch((error: unknown) => {
            if (error instanceof ConnectError && error.code === Code.NotFound) return undefined;
            throw fail(Code.Unavailable, "configuration.unavailable", error);
          });
    if (!current) throw notFound("configuration.missingRole");
    if (draft.resourceVersion !== roleDefinition(current).resourceVersion)
      throw conflict("configuration.conflict");
    const role = await checked(draft);
    const value = current.resource?.value ?? {};
    try {
      const metadata = object(value.metadata);
      const annotations = { ...object(metadata.annotations) };
      if (role.displayName.trim()) annotations[displayNameKey] = role.displayName.trim();
      else delete annotations[displayNameKey];
      const agentTemplate = await replaceTemplate(
        create(AgentTemplateSchema, {
          ref,
          resource: {
            apiVersion,
            kind: "AgentTemplate",
            value: {
              ...value,
              metadata: { ...metadata, annotations, resourceVersion: role.resourceVersion },
              spec: templateSpec(role, object(value.spec)),
            },
          },
        }),
      );
      if (!agentTemplate) throw fail(Code.Unavailable, "configuration.saveFailed");
      return { role: roleDefinition(agentTemplate) };
    } catch (error) {
      throw saveFailed(error);
    }
  }

  /** Aligns every engineer's bindings with the current execution requirements. */
  async function alignRoles(): Promise<string[]> {
    const [{ templates, servers }, view] = await Promise.all([catalog(), access()]);
    const updated: string[] = [];
    for (const template of templates) {
      const role = roleDefinition(template);
      const tools = view.bindings(role.name, role.tools, servers, false) ?? [];
      if (isDeepStrictEqual(tools, role.tools)) continue;
      const value = template.resource?.value ?? {};
      try {
        await replaceTemplate(
          create(AgentTemplateSchema, {
            ref: template.ref,
            resource: {
              apiVersion,
              kind: "AgentTemplate",
              value: {
                ...value,
                spec: templateSpec(
                  { ...role, tools: await platformTools(role.name, tools) },
                  object(value.spec),
                ),
              },
            },
          }),
        );
      } catch (error) {
        throw saveFailed(error);
      }
      updated.push(role.name);
    }
    return updated;
  }

  return { configuration, explain, createRole, updateRole, alignRoles };
}
