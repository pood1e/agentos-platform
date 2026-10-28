import { clone, create } from "@bufbuild/protobuf";
import { Code, ConnectError, type ServiceImpl } from "@connectrpc/connect";
import { AccessProfileSchema } from "../../gen/agentos/console/v1/access_pb.js";
import {
  type ConsoleService,
  WatchConversationResponseSchema,
} from "../../gen/agentos/console/v1/console_service_pb.js";
import type { RoleDefinition } from "../../gen/agentos/console/v1/role_pb.js";
import { isAdministrator } from "../../shared/permissions.js";
import type { BindingView } from "../governance/bindings.js";
import type { KagentClients } from "../kagent/clients.js";
import type { ToolMetadata } from "../kagent/tool-metadata.js";
import type { McpApps } from "../mcp-apps/service.js";
import { accessProfile, requestIdentity } from "../platform/access.js";
import { agentKey } from "../read-model/agents.js";
import { ingest } from "../read-model/entry.js";
import { TaskGraph } from "../read-model/graph.js";
import type { TaskQueries } from "../read-model/queries.js";
import { TaskStreams } from "../read-model/streams.js";
import { conversation, type FullTask } from "../read-model/views/conversation.js";
import { engineers } from "../read-model/views/engineers.js";
import { invalid, notFound, precondition, unavailable } from "../shared/errors.js";
import { type VoiceConsole, voiceDisabled } from "../voice/console.js";
import { cancellationCommands } from "./cancellation.js";
import { conversationTranscript } from "./conversation-transcript.js";
import { conversationCommands } from "./conversations.js";
import { chatTarget, systemConversation, viewer, visibleGraph } from "./history.js";
import { type AuthorizeTools, interactionPermissions } from "./interaction-permissions.js";
import { messageCommands } from "./messages.js";
import { type RoleDefaults, roleCommands } from "./roles.js";
import { watch } from "./watch.js";

export interface ConsoleDependencies {
  apps?: McpApps;
  metadata?: ToolMetadata;
  projection: TaskQueries;
  clients: KagentClients;
  namespace: string;
  access: BindingView;
  roleDefaults: RoleDefaults;
  voice?: VoiceConsole;
  entryAgent?: string;
  authorizeTools?: AuthorizeTools;
  /** Where browsers obtain the offline grant for background execution. */
  delegationUrl?: string;
}

function required(role?: RoleDefinition): RoleDefinition {
  if (!role) throw invalid("configuration.invalidRole");
  return role;
}

export function consoleService({
  apps,
  metadata,
  projection,
  clients,
  namespace,
  access,
  roleDefaults,
  voice = voiceDisabled,
  entryAgent = "assistant",
  authorizeTools,
  delegationUrl = "",
}: ConsoleDependencies): ServiceImpl<typeof ConsoleService> {
  const cancel = cancellationCommands(projection, clients);
  const messages = messageCommands(projection, clients, namespace, authorizeTools);
  const conversations = conversationCommands(clients, namespace, entryAgent);
  const roles = roleCommands(clients, namespace, access, roleDefaults, metadata);
  const { canOperate, approvalsFor } = interactionPermissions(projection, clients, authorizeTools);
  const visible = async (identity: Parameters<typeof viewer>[0], taskId: string) =>
    (await visibleGraph(projection, viewer(identity), { taskId }))?.entry(taskId);
  return {
    ...voice,
    getAppResource: (request, context) => {
      if (!apps) throw unavailable();
      return apps.getResource(request, context.values.get(requestIdentity), context.signal);
    },
    callAppTool: (request, context) => {
      if (!apps) throw unavailable();
      return apps.callTool(request, context.values.get(requestIdentity), context.signal);
    },
    async getAccessProfile(_request, context) {
      const profile = clone(AccessProfileSchema, context.values.get(accessProfile));
      profile.delegated = (await clients.execution.getDelegationCredentialStatus({})).renewable;
      profile.delegationUrl = delegationUrl;
      return { profile };
    },
    async listEngineers(_request, context) {
      const activity = await projection.agentActivity(viewer(context.values.get(requestIdentity)));
      return { engineers: engineers(await projection.agents(), activity) };
    },
    async listTasks(request, context) {
      const identity = context.values.get(requestIdentity);
      if (request.systemOnly && !isAdministrator(identity))
        throw new ConnectError("Permission denied", Code.PermissionDenied);
      return projection.operations(viewer(identity, request.systemOnly), request);
    },
    async cancelTask({ taskId }, context) {
      await cancel(taskId, context.values.get(requestIdentity), context.signal);
      return {};
    },
    async listConversations(request, context) {
      const identity = context.values.get(requestIdentity);
      chatTarget(namespace, entryAgent, request.agent, identity);
      return projection.conversations(viewer(identity), agentKey(request.agent), request);
    },
    deleteSession: (request, context) =>
      conversations.remove(request, context.values.get(requestIdentity)),
    async *watchConversation(request, context) {
      const identity = context.values.get(requestIdentity);
      const reader = viewer(
        identity,
        systemConversation(namespace, entryAgent, request.agent, identity, request.contextId),
      );
      let touch = () => {};
      const streams = new TaskStreams(clients, context.signal, () => touch());
      const fullTask: FullTask = async (entry) =>
        streams.task(entry.id) ?? projection.fullTask(entry);
      yield* watch(
        projection,
        WatchConversationResponseSchema,
        context.signal,
        async () => {
          let graph = new TaskGraph([], [], await projection.agents());
          if (request.contextId) {
            const tree = await visibleGraph(projection, reader, { contextId: request.contextId });
            if (tree?.session(request.contextId)?.agentId !== agentKey(request.agent))
              throw notFound("chat.invalidConversation");
            streams.follow(tree.all());
            // Live streams are fresher than the projection while their tasks run.
            graph = new TaskGraph(
              tree.all().map((entry) => {
                const task = streams.task(entry.id);
                return task ? ingest(task, entry.agentId, entry.execution) : entry;
              }),
              tree.sessions(),
              tree.agents(),
            );
          }
          const view = await conversation(graph, request.agent, request.contextId, fullTask);
          await apps?.project(view, graph, fullTask);
          view.operate =
            !request.contextId || (await canOperate(request.contextId, identity.subject));
          if (view.interactions.length)
            await approvalsFor(view.interactions, identity.subject, view.operate);
          return create(WatchConversationResponseSchema, {
            conversation: conversationTranscript(view),
          });
        },
        {
          wakes: (wake) => {
            touch = wake;
            return () => streams.close();
          },
        },
      );
    },
    async sendMessage(request, context) {
      const identity = context.values.get(requestIdentity);
      chatTarget(namespace, entryAgent, request.agent, identity);
      if (!(await clients.execution.getDelegationCredentialStatus({})).renewable)
        throw precondition("delegation.required");
      return messages.send(request, identity);
    },
    async respondInteraction(request, context) {
      const identity = context.values.get(requestIdentity);
      if (!(await visible(identity, request.taskId))) throw notFound("task.notFound");
      return messages.respond(request);
    },
    getConfiguration: () => roles.configuration(),
    createRole: (request) => roles.createRole(required(request.role), request.harness),
    updateRole: (request) => roles.updateRole(required(request.role)),
    explainTools: (request) => roles.explain(request.engineer),
  };
}
