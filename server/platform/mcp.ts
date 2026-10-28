import type { FastifyInstance } from "fastify";
import { decodeJwt } from "jose";
import { actorTokenHeader } from "../authorization/actor.js";
import { scopedCollaboration } from "../authorization/context.js";
import { discoveryMethods } from "../authorization/mcp.js";
import type { ExecutionRuntime } from "../authorization/runtime.js";
import { executionPrincipal } from "../authorization/workload-principal.js";
import type { WorkloadIdentity } from "../authorization/workloads.js";
import { executionTools } from "../execution/tools.js";
import type { BindingView } from "../governance/bindings.js";
import type { KagentClients } from "../kagent/clients.js";
import type { knowledgeService } from "../knowledge/service.js";
import type { TaskQueries } from "../read-model/queries.js";
import type { KagentConfig } from "../shared/config.js";
import { registerTeamSessions } from "../team-sessions/app.js";
import { sessionTools } from "../team-sessions/tools.js";

export async function registerPlatformMcp(
  app: FastifyInstance,
  config: KagentConfig,
  clients: KagentClients,
  projection: TaskQueries,
  execution: ExecutionRuntime,
  workloads: WorkloadIdentity,
  access: BindingView,
  knowledge: ReturnType<typeof knowledgeService>,
) {
  const tools = sessionTools(clients, config.namespace, access, knowledge);
  await registerTeamSessions(app, tools, async (headers, method, tool) => {
    const authorization = typeof headers.authorization === "string" ? headers.authorization : "";
    const claims =
      headers[actorTokenHeader] === undefined && /^Bearer [^\s,]+$/.test(authorization)
        ? decodeJwt(authorization.slice(7))
        : undefined;
    const actorProof =
      headers[actorTokenHeader] ?? (claims?.iss === execution.issuer ? authorization : undefined);
    if (actorProof === undefined) {
      if (workloads.config.executionSources.some((source) => source.issuer === claims?.iss)) {
        const source = await workloads.execution(headers);
        return {
          clientId: source.subject,
          scopes: ["run_execution", "get_execution", "cancel_execution"],
          handler: executionTools(
            clients,
            projection,
            config.namespace,
            execution.registry,
            executionPrincipal(source),
            source.agents,
          ),
        };
      }
      await workloads.controller(headers, method);
      return {
        clientId: workloads.config.controllerSubject,
        scopes: [
          "list_agents",
          "create_session",
          "dispatch_session",
          "list_role_tools",
          "prepare_role",
          "search_knowledge",
        ],
      };
    }
    const parent = await execution.actor(
      { ...headers, [actorTokenHeader]: actorProof },
      workloads.config.mcpAudience,
    );
    await execution.registry.resolve(parent);
    const { role } = await execution.agentRole(parent);
    const scopes = role.tools
      .filter((binding) => binding.server === "team-sessions")
      .flatMap((binding) => binding.tools);
    if (!discoveryMethods.has(method)) {
      if (!scopes.includes(tool)) throw new Error("Tool is outside the Agent's binding");
      await execution.authorizeTools(parent, [tool]);
    }
    return {
      clientId: parent.id,
      scopes,
      handler: scopedCollaboration(tools, parent, execution.registry),
    };
  });
}
