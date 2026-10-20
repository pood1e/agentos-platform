import { create } from "@bufbuild/protobuf";
import type { ServiceImpl } from "@connectrpc/connect";
import {
  type ConsoleService,
  WatchConversationResponseSchema,
  WatchTaskResponseSchema,
} from "../../gen/agentos/console/v1/console_service_pb.js";
import type { Pack } from "../../gen/agentos/console/v1/pack_pb.js";
import type { RoleDefinition } from "../../gen/agentos/console/v1/role_pb.js";
import type { OperationsConfig } from "../../gen/agentos/governance/v1/change_pb.js";
import type { KagentClients } from "../kagent/clients.js";
import type { BindingView } from "../operations/bindings.js";
import { changes } from "../operations/views.js";
import { accessProfile } from "../platform/access.js";
import type { KagentSync } from "../read-model/sync.js";
import { conversation, listConversations } from "../read-model/views/conversation.js";
import { engineers } from "../read-model/views/engineers.js";
import { taskRun } from "../read-model/views/run.js";
import { listTasks, taskDetail } from "../read-model/views/task.js";
import { invalid, notFound, unavailable } from "../shared/errors.js";
import { messageCommands } from "./messages.js";
import { type RoleDefaults, roleCommands } from "./roles.js";
import type { TemplateWriter } from "./template-writer.js";
import { ticketReferences } from "./ticket-references.js";
import { watch } from "./watch.js";

export interface ConsoleDependencies {
  sync: KagentSync;
  clients: KagentClients;
  namespace: string;
  access: BindingView;
  operations: OperationsConfig;
  roleDefaults: RoleDefaults;
  replaceTemplate: TemplateWriter;
  pack: Pack;
  platformTools?: Parameters<typeof roleCommands>[5];
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
}: ConsoleDependencies): ServiceImpl<typeof ConsoleService> {
  const index = sync.index;
  const messages = messageCommands(sync, clients);
  const roles = roleCommands(
    clients,
    namespace,
    access,
    roleDefaults,
    replaceTemplate,
    platformTools,
  );
  const tickets = ticketReferences(sync, operations);
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
    listConversations(request) {
      ready();
      return listConversations(index, request.kind, request);
    },
    watchConversation(request, context) {
      return watch(sync, WatchConversationResponseSchema, context.signal, async () =>
        create(WatchConversationResponseSchema, {
          conversation: await conversation(sync, request.kind, request.contextId),
        }),
      );
    },
    sendMessage: (request) => messages.send(request),
    respondInteraction: (request) => messages.respond(request),
    getConfiguration: () => roles.configuration(),
    getPack: () => ({ pack }),
    createRole: (request) => roles.createRole(required(request.role), request.harness),
    updateRole: (request) => roles.updateRole(required(request.role)),
    explainTools: (request) => roles.explain(request.engineer),
    listChanges: (request, context) =>
      changes(sync, operations, request.taskId, request.requestId, { signal: context.signal }),
  };
}
