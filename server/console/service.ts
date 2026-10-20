import { create } from "@bufbuild/protobuf";
import type { ServiceImpl } from "@connectrpc/connect";
import {
  type ConsoleService,
  WatchConversationResponseSchema,
  WatchTaskResponseSchema,
} from "../../gen/agentos/console/v1/console_service_pb.js";
import type { Pack } from "../../gen/agentos/console/v1/pack_pb.js";
import type { RoleDefinition } from "../../gen/agentos/console/v1/role_pb.js";
import type { GovernanceConfig } from "../../gen/agentos/governance/v1/governance_pb.js";
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
import { approvalReferences } from "./approval-references.js";
import { messageCommands } from "./messages.js";
import { type RoleDefaults, roleCommands } from "./roles.js";
import type { TemplateWriter } from "./template-writer.js";
import { watch } from "./watch.js";

export interface ConsoleDependencies {
  sync: KagentSync;
  clients: KagentClients;
  namespace: string;
  access: BindingView;
  operations: GovernanceConfig;
  roleDefaults: RoleDefaults;
  replaceTemplate: TemplateWriter;
  pack: Pack;
  platformTools?: Parameters<typeof roleCommands>[5];
  executions?: Executions;
  authorizeTools?: (
    session: import("../../gen/kagent/api/v1alpha1/sessions_pb.js").Session,
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
  roleDefaults,
  replaceTemplate,
  pack,
  platformTools,
  executions,
  authorizeTools,
}: ConsoleDependencies): ServiceImpl<typeof ConsoleService> {
  const index = sync.index;
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
    getAccessProfile: (_request, context) => ({ profile: context.values.get(accessProfile) }),
    listEngineers() {
      ready();
      return { engineers: engineers(index) };
    },
    listTasks(request) {
      ready();
      return listTasks(index, request);
    },
    watchTask(request, context) {
      return watch(
        sync,
        WatchTaskResponseSchema,
        context.signal,
        async () => {
          const task = taskDetail(index, request.taskId);
          if (!task) throw notFound("task.notFound");
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
    async getTaskRun(request) {
      ready();
      const run = await taskRun(sync, request.taskId);
      if (!run) throw notFound("task.notFound");
      return { run };
    },
    async cancelTask({ taskId }, context) {
      ready();
      const root = index.operationRoot(taskId);
      const tree = root && taskTree(index, root.id);
      if (!tree) throw notFound("task.notFound");
      if (executions) {
        const { session } = await clients.sessions.getSession({ sessionId: tree.root.contextId });
        if (!session) throw notFound("task.notFound");
        await relatedExecutions(
          executions,
          clients.sessions,
          session,
          tree.entries.map((entry) => entry.contextId),
          true,
        );
        await executions.revoke(session, context.values.get(requestIdentity));
      }
      await cancelTree(clients, sync, tree, context.signal);
      return {};
    },
    listConversations(request) {
      ready();
      return listConversations(index, request.agent, request);
    },
    watchConversation(request, context) {
      return watch(sync, WatchConversationResponseSchema, context.signal, async () => {
        const view = await conversation(sync, request.agent, request.contextId);
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
    sendMessage: (request, context) => messages.send(request, context.values.get(requestIdentity)),
    respondInteraction: (request, context) =>
      messages.respond(request, context.values.get(requestIdentity)),
    getConfiguration: () => roles.configuration(),
    getPack: () => ({ pack }),
    createRole: (request) => roles.createRole(required(request.role), request.harness),
    updateRole: (request) => roles.updateRole(required(request.role)),
    explainTools: (request) => roles.explain(request.engineer),
    listApprovals: (request, context) =>
      approvals(sync, operations, request.taskId, request.requestId, { signal: context.signal }),
  };
}
