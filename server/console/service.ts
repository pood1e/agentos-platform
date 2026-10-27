import { clone, create } from "@bufbuild/protobuf";
import { Code, ConnectError, type ServiceImpl } from "@connectrpc/connect";
import { AccessProfileSchema } from "../../gen/agentos/console/v1/access_pb.js";
import {
  type ConsoleService,
  WatchConversationResponseSchema,
} from "../../gen/agentos/console/v1/console_service_pb.js";
import type { Pack } from "../../gen/agentos/console/v1/pack_pb.js";
import type { RoleDefinition } from "../../gen/agentos/console/v1/role_pb.js";
import type { GovernanceConfig } from "../../gen/agentos/governance/v1/governance_pb.js";
import { isAdministrator } from "../../shared/permissions.js";
import type { EnvironmentTokens } from "../authorization/environment-tokens.js";
import type { Executions } from "../authorization/executions.js";
import type { BindingView } from "../governance/bindings.js";
import { approvals } from "../governance/views.js";
import type { KagentClients } from "../kagent/clients.js";
import type { ToolMetadata } from "../kagent/tool-metadata.js";
import type { McpApps } from "../mcp-apps/service.js";
import { accessProfile, requestIdentity } from "../platform/access.js";
import { agentKey } from "../read-model/agents.js";
import { ingest } from "../read-model/entry.js";
import { TaskGraph } from "../read-model/graph.js";
import type { TaskProjection } from "../read-model/projection.js";
import { refreshSession } from "../read-model/reconcile.js";
import { TaskStreams } from "../read-model/streams.js";
import { conversation, type FullTask } from "../read-model/views/conversation.js";
import { engineers } from "../read-model/views/engineers.js";
import { invalid, notFound, precondition, unavailable } from "../shared/errors.js";
import { exclusiveCommands } from "../shared/exclusive.js";
import { speechService } from "../speech/service.js";
import type { TaskTagStore } from "../tasks/tags.js";
import { approvalQueue } from "./approval-queue.js";
import { approvalReferences } from "./approval-references.js";
import { cancellationCommands } from "./cancellation.js";
import { conversationTranscript } from "./conversation-transcript.js";
import { conversationCommands } from "./conversations.js";
import { chatTarget, systemConversation, viewer, visibleGraph } from "./history.js";
import { type AuthorizeTools, interactionPermissions } from "./interaction-permissions.js";
import { messageCommands } from "./messages.js";
import { type RoleDefaults, roleCommands } from "./roles.js";
import { taskTagCommands } from "./task-tags.js";
import type { TemplateWriter } from "./template-writer.js";
import { watch } from "./watch.js";

export interface ConsoleDependencies {
  apps?: McpApps;
  metadata?: ToolMetadata;
  environmentToken?: EnvironmentTokens;
  projection: TaskProjection;
  clients: KagentClients;
  namespace: string;
  access: BindingView;
  operations: GovernanceConfig;
  roleDefaults: RoleDefaults;
  replaceTemplate: TemplateWriter;
  pack: Pack;
  tags: TaskTagStore;
  speech?: ReturnType<typeof speechService>;
  executions: Executions;
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
  operations,
  environmentToken,
  roleDefaults,
  replaceTemplate,
  pack,
  tags,
  speech = speechService(),
  executions,
  entryAgent = "assistant",
  authorizeTools,
  delegationUrl = "",
}: ConsoleDependencies): ServiceImpl<typeof ConsoleService> {
  const taskTags = taskTagCommands(clients, tags, executions);
  const exclusive = exclusiveCommands();
  const cancel = cancellationCommands(projection, clients, executions, exclusive);
  const messages = messageCommands(
    projection,
    clients,
    namespace,
    executions,
    operations,
    authorizeTools,
    exclusive,
  );
  const conversations = conversationCommands(
    projection,
    clients,
    namespace,
    entryAgent,
    executions,
    exclusive,
  );
  const roles = roleCommands(clients, namespace, access, roleDefaults, replaceTemplate, metadata);
  const withApprovals = approvalReferences(projection, operations, environmentToken);
  const { canOperate, approvalsFor } = interactionPermissions(
    projection,
    clients,
    operations,
    executions,
    authorizeTools,
  );
  const visible = async (identity: Parameters<typeof viewer>[0], taskId: string) =>
    (await visibleGraph(projection, viewer(identity), { taskId }))?.entry(taskId);
  return {
    ...speech,
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
      profile.delegated = await executions.delegated(profile.subject);
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
    async updateTaskTags(request, context) {
      const identity = context.values.get(requestIdentity);
      const graph = await visibleGraph(projection, viewer(identity), { taskId: request.taskId });
      const result = await taskTags.update(request, graph, identity);
      await projection.touch(result.task.id);
      return result;
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
      let root: string | undefined;
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
            if (!(await projection.session(request.contextId)))
              await refreshSession(projection, clients, request.contextId, context.signal);
            const tree = await visibleGraph(projection, reader, { contextId: request.contextId });
            if (tree?.session(request.contextId)?.agentId !== agentKey(request.agent))
              throw notFound("chat.invalidConversation");
            root = (await projection.session(request.contextId))?.root;
            streams.follow(tree.all());
            // Live streams are fresher than the projection while their tasks run.
            graph = new TaskGraph(
              tree.all().map((entry) => {
                const task = streams.task(entry.id);
                return task ? ingest(task, entry.agentId) : entry;
              }),
              tree.sessions(),
              tree.agents(),
            );
          }
          const view = await conversation(graph, request.agent, request.contextId, fullTask);
          await apps?.project(view, graph, fullTask);
          await taskTags.conversation(view);
          view.operate =
            !request.contextId || (await canOperate(request.contextId, identity.subject));
          if (view.interactions.length)
            await approvalsFor(view.interactions, identity.subject, view.operate);
          return create(WatchConversationResponseSchema, {
            conversation: conversationTranscript(await withApprovals(view)),
          });
        },
        {
          roots: () => (root ? new Set([root]) : undefined),
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
      if (!(await executions.delegated(identity.subject)))
        throw precondition("delegation.required");
      return messages.send(request, identity);
    },
    async respondInteraction(request, context) {
      const identity = context.values.get(requestIdentity);
      if (!(await visible(identity, request.taskId))) throw notFound("task.notFound");
      return messages.respond(request, identity);
    },
    getConfiguration: () => roles.configuration(),
    getPack: () => ({ pack }),
    createRole: (request) => roles.createRole(required(request.role), request.harness),
    updateRole: (request) => roles.updateRole(required(request.role)),
    explainTools: (request) => roles.explain(request.engineer),
    async listApprovals(request, context) {
      const identity = context.values.get(requestIdentity);
      if (!isAdministrator(identity) && !(await visible(identity, request.taskId)))
        throw notFound("task.notFound");
      return approvals(
        projection,
        operations,
        request.taskId,
        request.requestId,
        { signal: context.signal },
        environmentToken,
      );
    },
    async listApprovalRequests(request, context) {
      const identity = context.values.get(requestIdentity);
      const { interactions } = await withApprovals({
        interactions: await projection.approvals(viewer(identity)),
      });
      const result = approvalQueue(interactions, request, identity.subject);
      await approvalsFor(
        result.requests.filter((item) => !item.external),
        identity.subject,
        true,
      );
      return result;
    },
  };
}
