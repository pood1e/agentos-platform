import { Code, ConnectError } from "@connectrpc/connect";
import type { ResourceReference } from "../../gen/kagent/api/v1/common_pb.js";
import type { KagentClients } from "../kagent/clients.js";

/** The MCP collaboration facade can see only agents and sessions of one evaluation variant. */
export function evaluationClients(
  native: KagentClients,
  namespace: string,
  prefix: string,
): KagentClients {
  const accepts = (ref?: Partial<Pick<ResourceReference, "namespace" | "name">>) =>
    ref?.namespace === namespace && ref.name?.startsWith(prefix);
  function checked(ref?: Partial<Pick<ResourceReference, "namespace" | "name">>) {
    if (!accepts(ref))
      throw new ConnectError("Resource is outside this evaluation", Code.PermissionDenied);
  }
  const session = async (
    id: string,
    options?: Parameters<KagentClients["sessions"]["getSession"]>[1],
  ) => {
    const response = await native.sessions.getSession({ sessionId: id }, options);
    checked(response.session?.agent);
    return response;
  };
  return {
    ...native,
    agents: {
      ...native.agents,
      listAgents: async (request, options) => {
        if (request.namespace !== namespace) checked(undefined);
        const response = await native.agents.listAgents(request, options);
        response.agents = response.agents.filter((agent) => accepts(agent.ref));
        return response;
      },
      getAgent: async (request, options) => {
        checked(request.ref);
        return native.agents.getAgent(request, options);
      },
    },
    sessions: {
      ...native.sessions,
      createSession: (request, options) => {
        checked(request.agent);
        return native.sessions.createSession(request, options);
      },
      getSession: (request, options) => session(request.sessionId ?? "", options),
    },
    templates: {
      ...native.templates,
      getAgentTemplate: (request, options) => {
        checked(request.ref);
        return native.templates.getAgentTemplate(request, options);
      },
      listAgentTemplates: async (request, options) => {
        if (request.namespace !== namespace) checked(undefined);
        const response = await native.templates.listAgentTemplates(request, options);
        response.agentTemplates = response.agentTemplates.filter((template) =>
          accepts(template.ref),
        );
        return response;
      },
    },
    models: {
      ...native.models,
      listModelConfigs: async (request, options) => {
        const response = await native.models.listModelConfigs(request, options);
        response.modelConfigs = response.modelConfigs.filter((model) => accepts(model.ref));
        return response;
      },
      getModelConfig: (request, options) => {
        checked(request.ref);
        return native.models.getModelConfig(request, options);
      },
    },
    harnesses: {
      ...native.harnesses,
      listHarnesses: async (request, options) => {
        if (request.namespace !== namespace) checked(undefined);
        const response = await native.harnesses.listHarnesses(request, options);
        response.harnesses = response.harnesses.filter((harness) => accepts(harness.ref));
        return response;
      },
    },
    tools: {
      ...native.tools,
      listToolServers: async (request, options) => {
        const response = await native.tools.listToolServers(request, options);
        response.toolServers = response.toolServers.filter(
          (server) =>
            server.ref.startsWith(`${namespace}/${prefix}`) ||
            server.ref.startsWith(`${namespace}/engineer-${prefix}`),
        );
        return response;
      },
    },
  };
}
