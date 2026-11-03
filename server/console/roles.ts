import { create, type JsonObject } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { AgentToolsSchema } from "../../gen/agentos/console/v1/agent_pb.js";
import type { RoleDefinition } from "../../gen/agentos/console/v1/role_pb.js";
import { ErrorInfoSchema } from "../../gen/google/rpc/error_details_pb.js";
import type { AgentTemplate } from "../../gen/kagent/api/v1/agent_templates_pb.js";
import {
  type ResourceReference,
  ResourceReferenceSchema,
} from "../../gen/kagent/api/v1/common_pb.js";
import type { ToolServer } from "../../gen/kagent/api/v1/tools_pb.js";
import { object } from "../../shared/json.js";
import {
  defaultModelConfig,
  displayNameAnnotation,
  kagentApiVersion,
} from "../../shared/kagent-resources.js";
import type { BindingView, ToolBindings } from "../governance/tool-bindings.js";
import { validateAgent } from "../kagent/admission.js";
import { listNativeAgents, listWorkspaceToolServers } from "../kagent/catalog.js";
import type { KagentClients } from "../kagent/clients.js";
import {
  isWorkflowTemplate,
  resource,
  systemTemplates,
  userResource,
} from "../kagent/resources.js";
import { roleDefinition, templateSpec } from "../kagent/role-template.js";
import type { ToolMetadata } from "../kagent/tool-metadata.js";
import { pool } from "../shared/async.js";
import { conflict, fail, invalid, notFound, unlessMissing } from "../shared/errors.js";
import { nativeRead, roleCatalog } from "./role-catalog.js";

const nativeWrite = { timeoutMs: 30_000 };

function saveFailed(error: unknown): ConnectError {
  if (error instanceof ConnectError) {
    if (error.findDetails(ErrorInfoSchema).some((detail) => detail.domain === "agentos.console"))
      return error;
    if (error.code === Code.AlreadyExists) return conflict("configuration.roleExists");
    if ([Code.InvalidArgument, Code.Aborted].includes(error.code)) return error;
  }
  return fail(Code.Unavailable, "configuration.saveFailed", error);
}

function savedRole(template: AgentTemplate | undefined) {
  if (!template) throw fail(Code.Unavailable, "configuration.saveFailed");
  return { role: roleDefinition(template) };
}

export function roleCommands(
  clients: KagentClients,
  namespace: string,
  access: BindingView,
  defaultHarness: string,
  metadata: ToolMetadata,
) {
  const catalog = roleCatalog(clients, namespace, access, metadata);
  const newTemplateSpec = (role: RoleDefinition) =>
    templateSpec(role, { modelConfig: { name: defaultModelConfig } });

  /** Selections the editor cannot see, such as app-only tools, survive an edit. */
  async function retainedTools(
    role: RoleDefinition,
    existing: AgentTemplate | undefined,
    servers: ToolServer[],
    policy: ToolBindings,
  ) {
    if (!existing) return [];
    const hidden = await Promise.all(
      roleDefinition(existing).tools.map(async (binding) => {
        const visible = new Set(await catalog.modelTools(binding, servers, policy));
        return { ...binding, tools: binding.tools.filter((name) => !visible.has(name)) };
      }),
    );
    return policy.bindings(
      role.name,
      hidden.filter((binding) => binding.tools.length),
      "normalize",
    );
  }

  async function checked(
    role: RoleDefinition,
    harness?: ResourceReference,
    existing?: AgentTemplate,
  ) {
    if (systemTemplates.has(role.name)) throw invalid("configuration.invalidRole");
    const current = await catalog.load();
    if (
      role.modelConfig &&
      ((role.modelConfig.namespace && role.modelConfig.namespace !== namespace) ||
        !current.modelConfigs.some((model) => model.ref?.name === role.modelConfig?.name))
    )
      throw invalid("management.invalidModel");
    const policy = await access();
    for (const binding of role.tools) {
      const visible = await catalog.modelTools(binding, current.servers, policy);
      if (visible.length !== binding.tools.length) throw invalid("configuration.invalidTools");
    }
    const retained = (await retainedTools(role, existing, current.servers, policy)) ?? [];
    const tools = policy.bindings(role.name, [...role.tools, ...retained], "validate");
    if (!tools) throw invalid("configuration.invalidTools");
    if (harness) {
      if (harness.namespace && harness.namespace !== namespace)
        throw invalid("harness.invalidReference");
      await validateAgent(
        clients,
        { namespace, name: role.name },
        {
          harnessRef: { name: harness.name },
          template: { inline: newTemplateSpec({ ...role, tools }) },
        },
      );
    }
    return { ...role, tools };
  }

  async function configuration() {
    const [{ templates, servers, modelConfigs }, agents, { harnesses }] = await Promise.all([
      catalog.load(),
      listNativeAgents(clients, namespace, nativeRead),
      clients.harnesses.listHarnesses({ namespace }, nativeRead),
    ]).catch((error: unknown) => {
      throw fail(Code.Unavailable, "configuration.unavailable", error);
    });
    const policy = await access();
    const roles = await Promise.all(
      templates.map(async (template) => {
        const role = roleDefinition(template);
        for (const binding of role.tools) {
          try {
            binding.tools = await catalog.modelTools(binding, servers, policy);
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
      agentTools: agents.map((agent) =>
        create(AgentToolsSchema, { agent: agent.ref, builtinCatalog: agent.builtinTools }),
      ),
      agents: agents.filter((agent) => !systemTemplates.has(agent.ref?.name ?? "")),
      harnesses,
      defaultHarness: { namespace, name: defaultHarness },
    };
  }

  async function explain(identity: string) {
    const [policy, servers] = await Promise.all([
      access(),
      listWorkspaceToolServers(clients, namespace, nativeRead),
    ]);
    const requirements = policy.requirements(identity);
    const grouped = new Map<string, string[]>();
    for (const requirement of requirements)
      grouped.set(requirement.server, [
        ...(grouped.get(requirement.server) ?? []),
        requirement.tool,
      ]);
    const visible = new Set<string>();
    await pool([...grouped], 4, async ([server, tools]) => {
      if (!servers.some((item) => item.ref.endsWith(`/${server}`))) return;
      for (const name of await catalog.modelTools({ server, tools }, servers, policy))
        visible.add(`${server}\u0000${name}`);
    });
    return {
      requirements: requirements.filter((item) => visible.has(`${item.server}\u0000${item.tool}`)),
    };
  }

  /** The Agent runs a role's template; a failed Agent creation leaves no orphan template. */
  async function createNative(
    role: RoleDefinition,
    displayName: string,
    harness: ResourceReference,
  ) {
    const ref = { namespace, name: role.name };
    const annotations: JsonObject = { [displayNameAnnotation]: displayName };
    const { agentTemplate } = await clients.templates.createAgentTemplate(
      {
        ref,
        resource: resource({
          apiVersion: kagentApiVersion,
          kind: "AgentTemplate",
          metadata: { name: role.name, namespace, annotations },
          spec: newTemplateSpec(role),
        }),
      },
      nativeWrite,
    );
    try {
      await clients.agents.createAgent(
        {
          ref,
          resource: resource({
            apiVersion: kagentApiVersion,
            kind: "Agent",
            metadata: {
              name: role.name,
              namespace,
              labels: { "agentos.dev/role": role.name },
              annotations: { ...annotations, "agentos.dev/description": role.description },
            },
            spec: {
              template: { ref: { name: role.name } },
              harnessRef: { name: harness.name },
            },
          }),
        },
        nativeWrite,
      );
    } catch (error) {
      await clients.templates.deleteAgentTemplate({ ref }, nativeRead).catch(() => {});
      throw error;
    }
    return agentTemplate;
  }

  async function createRole(draft: RoleDefinition, harness?: ResourceReference) {
    const displayName = draft.displayName.trim();
    if (!displayName) throw invalid("configuration.invalidRole");
    const selected =
      harness ?? create(ResourceReferenceSchema, { namespace, name: defaultHarness });
    const role = await checked(draft, selected);
    try {
      return savedRole(await createNative(role, displayName, selected));
    } catch (error) {
      throw saveFailed(error);
    }
  }

  async function updateRole(draft: RoleDefinition) {
    const ref = { namespace, name: draft.name };
    const current = systemTemplates.has(draft.name)
      ? undefined
      : await unlessMissing(clients.templates.getAgentTemplate({ ref }, nativeRead))
          .then((response) => response?.agentTemplate)
          .catch((error: unknown) => {
            throw fail(Code.Unavailable, "configuration.unavailable", error);
          });
    if (!current || isWorkflowTemplate(current.resource?.value?.spec))
      throw notFound("configuration.missingRole");
    if (draft.resourceVersion !== roleDefinition(current).resourceVersion)
      throw conflict("configuration.conflict");
    const role = await checked(draft, undefined, current);
    const value = current.resource?.value ?? {};
    const previous = object(value.metadata);
    const annotations = { ...object(previous.annotations) };
    if (role.displayName.trim()) annotations[displayNameAnnotation] = role.displayName.trim();
    else delete annotations[displayNameAnnotation];
    try {
      const { agentTemplate } = await clients.templates.updateAgentTemplate(
        {
          ref,
          resource: {
            apiVersion: kagentApiVersion,
            kind: "AgentTemplate",
            value: userResource({
              ...value,
              metadata: { ...previous, annotations, resourceVersion: role.resourceVersion },
              spec: templateSpec(role, object(value.spec)),
            }),
          },
        },
        nativeWrite,
      );
      return savedRole(agentTemplate);
    } catch (error) {
      throw saveFailed(error);
    }
  }

  return { configuration, explain, createRole, updateRole };
}
