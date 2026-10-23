import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type ServiceImpl } from "@connectrpc/connect";
import {
  type ConsoleService,
  WatchConversationResponseSchema,
  WatchTaskResponseSchema,
} from "../../gen/agentos/console/v1/console_service_pb.js";
import type { Pack } from "../../gen/agentos/console/v1/pack_pb.js";
import type { RoleDefinition } from "../../gen/agentos/console/v1/role_pb.js";
import type { GovernanceConfig } from "../../gen/agentos/governance/v1/governance_pb.js";
import { isAdministrator } from "../../shared/permissions.js";
import { type Executions, relatedExecutions } from "../authorization/executions.js";
import type { BindingView } from "../governance/bindings.js";
import { approvals } from "../governance/views.js";
import type { KagentClients } from "../kagent/clients.js";
import { accessProfile, requestIdentity } from "../platform/access.js";
import { cancelTree } from "../read-model/cancel.js";
import type { KagentSync } from "../read-model/sync.js";
import { taskTree } from "../read-model/tree.js";
import { conversation, listConversations } from "../read-model/views/conversation.js";
import { engineers } from "../read-model/views/engineers.js";
import { taskRun } from "../read-model/views/run.js";
import { listTasks, taskDetail } from "../read-model/views/task.js";
import { invalid, notFound, unavailable } from "../shared/errors.js";
import { speechService } from "../speech/service.js";
import type { TaskTagStore } from "../tasks/tags.js";
import { approvalReferences } from "./approval-references.js";
import { chatTarget, executionHistory } from "./history.js";
import { messageCommands } from "./messages.js";
import { type RoleDefaults, roleCommands } from "./roles.js";
import { taskTagCommands } from "./task-tags.js";
import type { TemplateWriter } from "./template-writer.js";
import { watch } from "./watch.js";

export interface ConsoleDependencies {
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
  platformTools?: Parameters<typeof roleCommands>[5];
  executions?: Executions;
  entryAgent?: string;
  authorizeTools?: (
    session: import("../../gen/kagent/api/v1/sessions_pb.js").Session,
    tools: string[],
  ) => Promise<void>;
}

function required(role?: RoleDefinition): RoleDefinition {
  if (!role) throw invalid("configuration.invalidRole");
  return role;
}

export function consoleService({
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
  platformTools,
  executions,
  entryAgent = "assistant",
  authorizeTools,
}: ConsoleDependencies): ServiceImpl<typeof ConsoleService> {
  const index = sync.index;
  const history = executionHistory(index, executions);
  const taskTags = taskTagCommands(clients, tags, executions);
  const messages = messageCommands(sync, clients, operations, executions, authorizeTools);
  const roles = roleCommands(
    clients,
    namespace,
    access,
    roleDefaults,
    replaceTemplate,
    platformTools,
  );
  const tickets = approvalReferences(sync, operations);
  const canOperate = async (contextId: string, subject: string) => {
    if (!executions) return true;
    try {
      const { session } = await clients.sessions.getSession({ sessionId: contextId });
      if (!session) return false;
      return (await executions.resolve(session)).binding.subject === subject;
    } catch {
      return false;
    }
  };
  const approvalsFor = async (
    interactions: import("../../gen/agentos/console/v1/task_pb.js").Interaction[],
    subject: string,
    operate: boolean,
  ) => {
    for (const interaction of interactions) {
      interaction.approve = false;
      if (!operate) continue;
      try {
        const entry = index.entry(interaction.taskId);
        if (!entry || !(await canOperate(entry.contextId, subject))) continue;
        const { session } = await clients.sessions.getSession({ sessionId: entry.contextId });
        if (authorizeTools) {
          if (!session) continue;
          await authorizeTools(
            session,
            interaction.tools.map((tool) => tool.name),
          );
        }
        interaction.approve = true;
      } catch {
        /* Permission failures leave the interaction readable. */
      }
    }
  };
  const ready = () => {
    if (!sync.healthy()) throw unavailable();
  };
  return {
    ...speech,
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
    async *watchTask(request, context) {
      const known = index.entry(request.taskId);
      if (!known || !index.session(known.contextId)) await sync.refresh();
      yield* watch(
        sync,
        WatchTaskResponseSchema,
        context.signal,
        async () => {
          const view = await history(context.values.get(requestIdentity));
          const task = taskDetail(view, request.taskId);
          if (!task) throw notFound("task.notFound");
          await taskTags.detail(task, view, context.values.get(requestIdentity));
          const entry = index.entry(request.taskId);
          task.operate =
            !!entry &&
            (await canOperate(entry.contextId, context.values.get(requestIdentity).subject));
          if (entry && task.interactions.length)
            await approvalsFor(
              task.interactions,
              context.values.get(requestIdentity).subject,
              task.operate,
            );
          return create(WatchTaskResponseSchema, { task: await tickets(task) });
        },
        true,
      );
    },
    async getTaskRun(request, context) {
      ready();
      const view = await history(context.values.get(requestIdentity));
      if (!view.entry(request.taskId)) throw notFound("task.notFound");
      const run = await taskRun(sync, request.taskId);
      if (!run) throw notFound("task.notFound");
      return { run };
    },
    async cancelTask({ taskId }, context) {
      ready();
      const visible = await history(context.values.get(requestIdentity));
      const root = visible.operationRoot(taskId);
      const tree = root && taskTree(visible, root.id);
      if (!tree) throw notFound("task.notFound");
      if (executions) {
        const { session } = await clients.sessions.getSession({ sessionId: tree.root.contextId });
        if (!session) throw notFound("task.notFound");
        await executions.own(session, context.values.get(requestIdentity));
        await relatedExecutions(
          executions,
          clients.sessions,
          session,
          tree.entries.map((entry) => entry.contextId),
        );
      }
      await cancelTree(clients, sync, tree, context.signal);
      return {};
    },
    async listConversations(request, context) {
      ready();
      const identity = context.values.get(requestIdentity);
      chatTarget(namespace, entryAgent, request.agent, identity);
      return listConversations(await history(identity), request.agent, request);
    },
    watchConversation(request, context) {
      return watch(sync, WatchConversationResponseSchema, context.signal, async () => {
        const identity = context.values.get(requestIdentity);
        chatTarget(namespace, entryAgent, request.agent, identity);
        const visible = await history(identity);
        if (
          request.contextId &&
          visible.session(request.contextId)?.agentId !==
            `${request.agent?.namespace}/${request.agent?.name}`
        )
          throw notFound("chat.invalidConversation");
        const view = await conversation(sync, request.agent, request.contextId, visible);
        view.operate =
          !request.contextId ||
          (await canOperate(request.contextId, context.values.get(requestIdentity).subject));
        if (view.pending.length)
          await approvalsFor(
            view.pending,
            context.values.get(requestIdentity).subject,
            view.operate,
          );
        return create(WatchConversationResponseSchema, { conversation: view });
      });
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
      if (!(await history(context.values.get(requestIdentity))).entry(request.taskId))
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
  };
}
