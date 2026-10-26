import { create } from "@bufbuild/protobuf";
import type { FastifyInstance } from "fastify";
import { decodeJwt } from "jose";
import type { ScheduledRunPreset } from "../../gen/agentos/automation/v1/service_pb.js";
import { ExecutionIdentitySchema } from "../../gen/agentos/execution/v1/identity_pb.js";
import { actorTokenHeader } from "../authorization/actor.js";
import { scopedCollaboration } from "../authorization/context.js";
import { relatedExecutions } from "../authorization/executions.js";
import { discoveryMethods } from "../authorization/mcp.js";
import type { ExecutionRuntime } from "../authorization/runtime.js";
import type { WorkloadIdentity } from "../authorization/workloads.js";
import { scheduledSourceTools } from "../automation/source-tools.js";
import type { BindingView } from "../governance/bindings.js";
import type { KagentClients } from "../kagent/clients.js";
import type { knowledgeService } from "../knowledge/service.js";
import type { KagentSync } from "../read-model/sync.js";
import type { KagentConfig } from "../shared/config.js";
import { registerTeamSessions } from "../team-sessions/app.js";
import { sessionTools } from "../team-sessions/tools.js";
import { automationTools } from "./automation.js";

export async function registerPlatformMcp(
  app: FastifyInstance,
  config: KagentConfig,
  clients: KagentClients,
  sync: KagentSync,
  execution: ExecutionRuntime,
  workloads: WorkloadIdentity,
  access: BindingView,
  knowledge: ReturnType<typeof knowledgeService>,
  presets: ScheduledRunPreset[] = [],
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
      if (workloads.config.automationSources.some((source) => source.issuer === claims?.iss)) {
        const source = await workloads.automation(headers);
        const { environment, subject } = source;
        if (source.scheduledRunPresets.length) {
          if (source.caseAgents.length || source.write || source.capabilities.length)
            throw new Error("A result reader requires an isolated read-only source identity");
          return {
            clientId: subject,
            scopes: ["list_scheduled_run_executions", "get_scheduled_run_execution_result"],
            handler: scheduledSourceTools(
              clients,
              sync,
              config.namespace,
              presets,
              source.scheduledRunPresets,
            ),
          };
        }
        if (
          !source.caseAgents.length ||
          source.caseAgents.some((agent) => agent.namespace !== config.namespace)
        )
          throw new Error("Source Agent bindings are required");
        return {
          clientId: subject,
          scopes: ["run_case", "observe_case", "cancel_case"],
          handler: automationTools(
            clients,
            sync,
            config.namespace,
            environment,
            async (session, cancel, contexts) => {
              const principal = create(ExecutionIdentitySchema, {
                subject: `service:automation:${environment}:${subject}`,
                write: source.write,
                capabilities: source.capabilities,
                credential: { case: "service", value: true },
              });
              await execution.registry.bind(session, principal);
              if (cancel) {
                await relatedExecutions(
                  execution.registry,
                  clients.sessions,
                  session,
                  contexts ?? [],
                  true,
                );
                await execution.registry.revoke(session, principal);
              }
            },
            source.caseAgents.map((agent) => agent.name),
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
