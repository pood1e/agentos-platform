import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type ServiceImpl } from "@connectrpc/connect";
import {
  type ConsoleService,
  WatchConversationResponseSchema,
} from "../../gen/agentos/console/v1/console_service_pb.js";
import type { Pack } from "../../gen/agentos/console/v1/pack_pb.js";
import type { RoleDefinition } from "../../gen/agentos/console/v1/role_pb.js";
import type { GovernanceConfig } from "../../gen/agentos/governance/v1/governance_pb.js";
import { isAdministrator } from "../../shared/permissions.js";
import type { Executions } from "../authorization/executions.js";
import type { BindingView } from "../governance/bindings.js";
import { approvals } from "../governance/views.js";
import type { KagentClients } from "../kagent/clients.js";
import type { ToolMetadata } from "../kagent/tool-metadata.js";
import type { McpApps } from "../mcp-apps/service.js";
import { accessProfile, requestIdentity } from "../platform/access.js";
import { ObservationScope } from "../read-model/observation.js";
import type { KagentSync } from "../read-model/sync.js";
import { conversation, listConversations } from "../read-model/views/conversation.js";
import { engineers } from "../read-model/views/engineers.js";
import { listTasks } from "../read-model/views/task.js";
import { invalid, notFound, unavailable } from "../shared/errors.js";
import { exclusiveCommands } from "../shared/exclusive.js";
import { speechService } from "../speech/service.js";
import type { TaskTagStore } from "../tasks/tags.js";
import { approvalQueue } from "./approval-queue.js";
import { approvalReferences } from "./approval-references.js";
import { cancellationCommands } from "./cancellation.js";
import { conversationTranscript } from "./conversation-transcript.js";
import { conversationCommands } from "./conversations.js";
import { chatTarget, executionHistory, systemConversation } from "./history.js";
import { type AuthorizeTools, interactionPermissions } from "./interaction-permissions.js";
import { messageCommands } from "./messages.js";
import { type RoleDefaults, roleCommands } from "./roles.js";
import { taskTagCommands } from "./task-tags.js";
import type { TemplateWriter } from "./template-writer.js";
import { watch } from "./watch.js";

export interface ConsoleDependencies {
  apps?: McpApps;
  metadata?: ToolMetadata;
  environmentToken?: import("../authorization/environment-tokens.js").EnvironmentTokens;
  sync: KagentSync;
  clients: KagentClients;
  namespace: string;
  access: BindingView;
  operations: GovernanceConfig;
  roleDefaults: RoleDefaults;
  replaceTemplate: TemplateWriter;
  pack: Pack;
  tags: TaskTagStore;
  speech?: ReturnType<typeof speechService>;
  executions?: Executions;
  entryAgent?: string;
  authorizeTools?: AuthorizeTools;
}

function required(role?: RoleDefinition): RoleDefinition {
  if (!role) throw invalid("configuration.invalidRole");
  return role;
}

export function consoleService({
  apps,
  metadata,
  sync,
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
}: ConsoleDependencies): ServiceImpl<typeof ConsoleService> {
  const index = sync.index;
  const history = executionHistory(index, executions);
  const taskTags = taskTagCommands(clients, tags, executions);
  const exclusive = exclusiveCommands();
  const cancel = cancellationCommands(sync, clients, executions, exclusive);
  const messages = messageCommands(
    sync,
    clients,
    operations,
    executions,
    authorizeTools,
    exclusive,
  );
  const conversations = conversationCommands(
    sync,
    clients,
    namespace,
    entryAgent,
    executions,
    exclusive,
  );
  const roles = roleCommands(clients, namespace, access, roleDefaults, replaceTemplate, metadata);
  const withApprovals = approvalReferences(sync, operations, environmentToken);
  const { canOperate, approvalsFor } = interactionPermissions(
    index,
    clients,
    operations,
    executions,
    authorizeTools,
  );
  const ready = () => {
    if (!sync.healthy()) throw unavailable();
  };
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
    getAccessProfile: (_request, context) => ({ profile: context.values.get(accessProfile) }),
    async listEngineers(_request, context) {
      ready();
      return { engineers: engineers(await history(context.values.get(requestIdentity))) };
    },
    async listTasks(request, context) {
      ready();
      const identity = context.values.get(requestIdentity);
      if (request.systemOnly && !isAdministrator(identity))
        throw new ConnectError("Permission denied", Code.PermissionDenied);
      const visible = await history(identity, request.systemOnly);
      const metadata = await tags.read(visible.relations().roots.map((root) => root.id));
      return listTasks(visible, request, metadata);
    },
    async updateTaskTags(request, context) {
      ready();
      const identity = context.values.get(requestIdentity);
      const result = await taskTags.update(request, await history(identity), identity);
      index.invalidate(result.task.id);
      return result;
    },
    async cancelTask({ taskId }, context) {
      ready();
      await cancel(taskId, context.values.get(requestIdentity), context.signal);
      return {};
    },
    async listConversations(request, context) {
      ready();
      const identity = context.values.get(requestIdentity);
      chatTarget(namespace, entryAgent, request.agent, identity);
      return listConversations(await history(identity), request.agent, request);
    },
    deleteSession: (request, context) => {
      ready();
      return conversations.remove(request, context.values.get(requestIdentity));
    },
    async *watchConversation(request, context) {
      if (request.contextId && !index.session(request.contextId)) await sync.refresh();
      const scope = new ObservationScope(index, { contextId: request.contextId });
      yield* watch(
        sync,
        WatchConversationResponseSchema,
        context.signal,
        async () => {
          const identity = context.values.get(requestIdentity);
          const systemOnly = systemConversation(
            namespace,
            entryAgent,
            request.agent,
            identity,
            request.contextId,
          );
          const visible = await history(identity, systemOnly, scope.contextIds());
          if (
            request.contextId &&
            visible.session(request.contextId)?.agentId !==
              `${request.agent?.namespace}/${request.agent?.name}`
          )
            throw notFound("chat.invalidConversation");
          const view = await conversation(sync, request.agent, request.contextId, visible);
          await apps?.project(view);
          await taskTags.conversation(view);
          view.operate =
            !request.contextId ||
            (await canOperate(request.contextId, context.values.get(requestIdentity).subject));
          if (view.interactions.length)
            await approvalsFor(
              view.interactions,
              context.values.get(requestIdentity).subject,
              view.operate,
            );
          return create(WatchConversationResponseSchema, {
            conversation: conversationTranscript(await withApprovals(view)),
          });
        },
        { scope },
      );
    },
    sendMessage: (request, context) => {
      const identity = context.values.get(requestIdentity);
      chatTarget(namespace, entryAgent, request.agent, identity);
      return messages.send(request, identity);
    },
    async respondInteraction(request, context) {
      if (!(await history(context.values.get(requestIdentity))).entry(request.taskId))
        throw notFound("task.notFound");
      return messages.respond(request, context.values.get(requestIdentity));
    },
    getConfiguration: () => roles.configuration(),
    getPack: () => ({ pack }),
    createRole: (request) => roles.createRole(required(request.role), request.harness),
    updateRole: (request) => roles.updateRole(required(request.role)),
    explainTools: (request) => roles.explain(request.engineer),
    async listApprovals(request, context) {
      ready();
      const identity = context.values.get(requestIdentity);
      if (!isAdministrator(identity) && !(await history(identity)).entry(request.taskId))
        throw notFound("task.notFound");
      return approvals(
        sync,
        operations,
        request.taskId,
        request.requestId,
        {
          signal: context.signal,
        },
        environmentToken,
      );
    },
    async listApprovalRequests(request, context) {
      ready();
      const identity = context.values.get(requestIdentity);
      const visible = isAdministrator(identity) ? index : await history(identity);
      const { interactions } = await withApprovals({
        interactions: visible.all().flatMap((entry) => entry.interactions),
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
