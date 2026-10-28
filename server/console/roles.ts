import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { EngineerToolsSchema } from "../../gen/agentos/console/v1/engineer_pb.js";
import type { RoleDefinition } from "../../gen/agentos/console/v1/role_pb.js";
import { ModelPurpose } from "../../gen/agentos/management/v1/management_pb.js";
import { ErrorInfoSchema } from "../../gen/google/rpc/error_details_pb.js";
import {
  type ResourceReference,
  ResourceReferenceSchema,
} from "../../gen/kagent/api/v1/common_pb.js";
import { modelPurpose } from "../../shared/model-purpose.js";
import type { BindingView } from "../governance/bindings.js";
import { validateAgent } from "../kagent/admission.js";
import type { KagentClients } from "../kagent/clients.js";
import { type ToolMetadata, toolMetadata } from "../kagent/tool-metadata.js";
import { userResource } from "../management/native.js";
import { systemRoles } from "../read-model/agents.js";
import { object } from "../read-model/decode/messages.js";
import { conflict, fail, invalid, notFound } from "../shared/errors.js";
import { apiVersion, displayNameKey, roleDefinition, templateSpec } from "./role-template.js";

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
    if ([Code.InvalidArgument, Code.Aborted].includes(error.code)) return error;
  }
  return fail(Code.Unavailable, "configuration.saveFailed", error);
}

export function roleCommands(
  clients: KagentClients,
  namespace: string,
  access: BindingView,
  defaults: RoleDefaults,
  metadata: ToolMetadata = toolMetadata(clients),
) {
  async function catalog() {
    const [templates, tools, models] = await Promise.all([
      clients.templates.listAgentTemplates({ namespace }, read),
      clients.tools.listToolServers({}, read),
      clients.models.listModelConfigs({}, read),
    ]).catch((error: unknown) => {
      throw fail(Code.Unavailable, "configuration.unavailable", error);
    });
    const policy = await access();
    const servers = tools.toolServers.filter((server) => server.ref.startsWith(`${namespace}/`));
    return {
      modelConfigs: models.modelConfigs.filter(
        (item) =>
          item.ref?.namespace === namespace &&
          modelPurpose(item.resource?.value) === ModelPurpose.LANGUAGE,
      ),
      templates: templates.agentTemplates.filter((item) => !systemRoles.has(item.ref?.name ?? "")),
      servers: await metadata.modelServers(servers, (server) =>
        policy.catalogServer(server, servers),
      ),
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
    if (selectedHarness) {
      if (selectedHarness.namespace && selectedHarness.namespace !== namespace)
        throw invalid("harness.invalidReference");
      await validateAgent(
        clients,
        { namespace, name: role.name },
        {
          harnessRef: { name: selectedHarness.name },
          template: {
            inline: templateSpec(
              { ...role, tools },
              { modelConfig: { name: defaults.modelConfig } },
            ),
          },
        },
      );
    }
    return { ...role, tools };
  }

  async function configuration() {
    const [{ templates, servers, modelConfigs }, { agents }, { harnesses }] = await Promise.all([
      catalog(),
      clients.agents.listAgents({ namespace }, read),
      clients.harnesses.listHarnesses({ namespace }, read),
    ]).catch((error: unknown) => {
      throw fail(Code.Unavailable, "configuration.unavailable", error);
    });
    const policy = await access();
    const roles = await Promise.all(
      templates.map(async (template) => {
        const role = roleDefinition(template);
        for (const binding of role.tools) {
          const server = servers.find((server) => server.ref.split("/").at(-1) === binding.server);
          if (!server) continue;
          try {
            binding.tools = await metadata.modelTools(
              policy.catalogServer(server, servers),
              binding.tools,
            );
          } catch {
            // Keep existing selections when discovery is unavailable; saves still validate the catalog.
          }
        }
        role.tools = role.tools.filter((binding) => binding.tools.length);
        return role;
      }),
    );
    return {
      roles,
      toolServers: servers,
      modelConfigs,
      engineerTools: agents.map((agent) =>
        create(EngineerToolsSchema, { engineer: agent.ref, builtinCatalog: agent.builtinTools }),
      ),
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
                  template: { ref: { name: role.name } },
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
      const { agentTemplate } = await clients.templates.updateAgentTemplate(
        {
          ref,
          resource: {
            apiVersion,
            kind: "AgentTemplate",
            value: userResource({
              ...value,
              metadata: { ...metadata, annotations, resourceVersion: role.resourceVersion },
              spec: templateSpec(role, object(value.spec)),
            }),
          },
        },
        write,
      );
      if (!agentTemplate) throw fail(Code.Unavailable, "configuration.saveFailed");
      return { role: roleDefinition(agentTemplate) };
    } catch (error) {
      throw saveFailed(error);
    }
  }

  /** Aligns every engineer's bindings with the current execution requirements. */
  return { configuration, explain, createRole, updateRole };
}
