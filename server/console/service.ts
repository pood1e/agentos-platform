import { clone } from "@bufbuild/protobuf";
import type { HandlerContext, ServiceImpl } from "@connectrpc/connect";
import { AccessProfileSchema } from "../../gen/agentos/console/v1/access_pb.js";
import type { ConsoleService } from "../../gen/agentos/console/v1/console_service_pb.js";
import type { RoleDefinition } from "../../gen/agentos/console/v1/role_pb.js";
import type { AppReference } from "../../gen/agentos/mcp/v1/app_pb.js";
import type { BindingView } from "../governance/tool-bindings.js";
import type { KagentClients } from "../kagent/clients.js";
import { nativeSignal } from "../kagent/context.js";
import { agentKey } from "../kagent/resources.js";
import type { ToolMetadata } from "../kagent/tool-metadata.js";
import type { McpApps } from "../mcp-apps/service.js";
import { accessProfile, requestIdentity } from "../platform/access.js";
import type { TaskQueries } from "../read-model/queries.js";
import { invalid, notFound, precondition } from "../shared/errors.js";
import { cancellationCommands } from "./cancellation.js";
import { conversationWatch } from "./conversation-watch.js";
import { conversationCommands } from "./conversations.js";
import { messageCommands } from "./messages.js";
import { roleCommands } from "./roles.js";
import { scheduleCommands } from "./schedules.js";
import { chatTarget, executionTarget, viewer, visibleGraph } from "./visibility.js";

/** Speech RPCs, provided by the voice feature where the deployment enables it. */
export type VoiceConsole = Pick<
  ServiceImpl<typeof ConsoleService>,
  "getSpeechCapabilities" | "startVoiceSession"
>;

const voiceDisabled: VoiceConsole = {
  getSpeechCapabilities: () => ({}),
  startVoiceSession: () => {
    throw precondition("speech.unavailable");
  },
};

export interface ConsoleDependencies {
  apps: McpApps;
  metadata: ToolMetadata;
  projection: TaskQueries;
  clients: KagentClients;
  namespace: string;
  access: BindingView;
  defaultHarness: string;
  voice?: VoiceConsole;
  entryAgent: string;
  /** Where browsers obtain the offline grant for background execution. */
  delegationUrl: string;
}

function required(role?: RoleDefinition): RoleDefinition {
  if (!role) throw invalid("configuration.invalidRole");
  return role;
}

const identityOf = (context: HandlerContext) => context.values.get(requestIdentity);

/** An App reference is valid only inside the workspace that received the request. */
function currentApp(reference: AppReference | undefined, context: HandlerContext) {
  if (reference?.workspace?.uid !== context.values.get(accessProfile).workspace?.uid)
    throw notFound("mcpApp.unavailable");
}

export function consoleService({
  apps,
  metadata,
  projection,
  clients,
  namespace,
  access,
  defaultHarness,
  voice = voiceDisabled,
  entryAgent,
  delegationUrl,
}: ConsoleDependencies): ServiceImpl<typeof ConsoleService> {
  const cancel = cancellationCommands(projection, clients);
  const messages = messageCommands(projection, clients, namespace);
  const conversations = conversationCommands(projection, clients, namespace, entryAgent);
  const roles = roleCommands(clients, namespace, access, defaultHarness, metadata);
  const watchConversation = conversationWatch({
    projection,
    clients,
    apps,
    namespace,
    entryAgent,
  });
  const renewable = async () =>
    (await clients.execution.getDelegationCredentialStatus({})).renewable;
  const schedules = scheduleCommands(clients, namespace, renewable);
  return {
    ...voice,
    getAppResource: (request, context) => {
      currentApp(request.app, context);
      return apps.getResource(request, identityOf(context), context.signal);
    },
    callAppTool: (request, context) => {
      currentApp(request.app, context);
      return apps.callTool(request, identityOf(context), context.signal);
    },
    async getAccessProfile(_request, context) {
      const profile = clone(AccessProfileSchema, context.values.get(accessProfile));
      profile.delegated = await renewable();
      profile.delegationUrl = delegationUrl;
      return { profile };
    },
    listAgents: (request, context) =>
      nativeSignal.run(context.signal, async () => ({
        agents: await projection.agentSummaries(viewer(identityOf(context), request.systemOnly)),
      })),
    listAgentRuns: (request, context) =>
      nativeSignal.run(context.signal, () =>
        projection.agentRuns(viewer(identityOf(context), request.systemOnly), request),
      ),
    listTasks: (request, context) =>
      nativeSignal.run(context.signal, () =>
        projection.operations(viewer(identityOf(context), request.systemOnly), request),
      ),
    async cancelTask({ taskId }, context) {
      await cancel(taskId, identityOf(context), context.signal);
      return {};
    },
    listConversations(request, context) {
      const identity = identityOf(context);
      chatTarget(namespace, entryAgent, request.agent, identity);
      return nativeSignal.run(context.signal, () =>
        projection.conversations(viewer(identity), agentKey(request.agent), request),
      );
    },
    deleteSession: (request, context) => conversations.remove(request, identityOf(context)),
    async *watchConversation(request, context) {
      yield* watchConversation(request, identityOf(context), context.signal);
    },
    async sendMessage(request, context) {
      const identity = identityOf(context);
      if (request.contextId) chatTarget(namespace, entryAgent, request.agent, identity);
      else executionTarget(namespace, request.agent, identity);
      if (!(await renewable())) throw precondition("delegation.required");
      return messages.send(request, identity);
    },
    async respondInteraction(request, context) {
      const graph = await visibleGraph(projection, viewer(identityOf(context)), {
        taskId: request.taskId,
      });
      if (!graph?.entry(request.taskId)) throw notFound("task.notFound");
      return messages.respond(request);
    },
    getConfiguration: () => roles.configuration(),
    createRole: (request) => roles.createRole(required(request.role), request.harness),
    updateRole: (request) => roles.updateRole(required(request.role)),
    explainTools: (request) => roles.explain(request.identity),
    listScheduledRuns: (request, context) =>
      nativeSignal.run(context.signal, () => schedules.list(request)),
    createScheduledRun: (request, context) => schedules.create(request, identityOf(context)),
    updateScheduledRun: (request) => schedules.update(request),
    deleteScheduledRun: (request) => schedules.remove(request),
    triggerScheduledRun: (request) => schedules.trigger(request),
    listScheduledRunExecutions: (request, context) =>
      nativeSignal.run(context.signal, () => schedules.executions(request)),
  };
}
