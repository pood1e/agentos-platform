import { create, fromJson, toJson } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import { Role } from "../../../gen/a2a_pb.js";
import {
  type ChatMessage,
  ChatMessageSchema,
  type Conversation,
  ConversationKind,
  ConversationSchema,
  type ConversationSummary,
  ConversationSummarySchema,
} from "../../../gen/agentos/console/v1/conversation_pb.js";
import {
  type RoleDefinition,
  RoleDefinitionSchema,
} from "../../../gen/agentos/console/v1/role_pb.js";
import { ActivityState } from "../../../gen/agentos/console/v1/state_pb.js";
import { toolCalls } from "../calls.js";
import { object } from "../decode/messages.js";
import { toolBaseName } from "../decode/tools.js";
import type { TaskEntry } from "../entry.js";
import type { TaskIndex } from "../index.js";
import { approvals } from "../interactions.js";
import { type PageRequest, pageOf } from "../page.js";
import { awaiting } from "../state.js";
import type { KagentSync } from "../sync.js";
import { busy, foreground, taskTree } from "../tree.js";
import { runState, stamp } from "./runs.js";
import { taskSummary } from "./task.js";

export const conversationRole = (kind: ConversationKind) =>
  kind === ConversationKind.ROLE_BUILDER ? "role-builder" : "assistant";

const members = (index: TaskIndex, kind: ConversationKind) =>
  index.agents().filter((agent) => agent.role === conversationRole(kind));

const lastActivity = (index: TaskIndex, contextId: string) =>
  Math.max(0, ...index.contextEntries(contextId).map((entry) => entry.statusAt ?? 0));

export function listConversations(index: TaskIndex, kind: ConversationKind, request: PageRequest) {
  const ids = new Set(members(index, kind).map((agent) => agent.id));
  const needle = request.query.trim().toLowerCase();
  const matches = index
    .sessions()
    .filter((session) => ids.has(session.agentId))
    .filter(
      (session) =>
        !needle ||
        `${session.name} ${index
          .contextEntries(session.id)
          .map((entry) => entry.prompt)
          .join(" ")}`
          .toLowerCase()
          .includes(needle),
    )
    .map((session) => ({
      session,
      at: Math.max(session.updatedAt ?? 0, lastActivity(index, session.id)),
    }))
    .sort((a, b) => b.at - a.at || a.session.id.localeCompare(b.session.id));
  const page = pageOf(matches, request, `conversations:${kind}`, (entry) => ({
    id: entry.session.id,
    time: entry.at,
  }));
  return {
    conversations: page.items.map(
      ({ session, at }): ConversationSummary =>
        create(ConversationSummarySchema, {
          contextId: session.id,
          title: session.name,
          updatedAt: stamp(at || undefined),
        }),
    ),
    totalSize: page.totalSize,
    nextPageToken: page.nextPageToken,
  };
}

/** Operations this conversation turn delegated to engineers. */
function operations(index: TaskIndex, entry: TaskEntry) {
  const roots = new Set(index.relations().roots.map((root) => root.id));
  return entry.calls.flatMap((call) => {
    const id = index.target(entry, call);
    const tree = id && roots.has(id) ? taskTree(index, id) : undefined;
    return tree ? [taskSummary(index, tree)] : [];
  });
}

function messages(index: TaskIndex, entries: TaskEntry[]): ChatMessage[] {
  const seen = new Set<string>();
  return entries.flatMap((entry) => {
    const turns = entry.userMessages
      .filter((message) => !seen.has(message.id))
      .map((message, position) => {
        seen.add(message.id);
        return create(ChatMessageSchema, {
          id: message.id,
          role: Role.USER,
          text: message.text,
          taskId: entry.id,
          tasks: position === 0 ? operations(index, entry) : [],
        });
      });
    return entry.answer
      ? [
          ...turns,
          create(ChatMessageSchema, {
            id: `answer:${entry.id}`,
            role: Role.AGENT,
            text: entry.answer,
            taskId: entry.id,
          }),
        ]
      : turns;
  });
}

async function roleDraft(sync: KagentSync, entry: TaskEntry): Promise<RoleDefinition | undefined> {
  const call = entry.calls.findLast(
    (item) => toolBaseName(item.name) === "prepare_role" && item.state === ActivityState.SUCCEEDED,
  );
  const task = call && (await sync.fullTask(entry.id));
  if (!task) return undefined;
  const output = toolCalls(task, entry.agentId, approvals(task)).find(
    (item) => item.id === call.id,
  )?.output;
  try {
    return output
      ? fromJson(RoleDefinitionSchema, object(toJson(ValueSchema, output)), {
          ignoreUnknownFields: true,
        })
      : undefined;
  } catch {
    return undefined;
  }
}

export async function conversation(
  sync: KagentSync,
  kind: ConversationKind,
  contextId: string,
): Promise<Conversation> {
  const index = sync.index;
  const ready = members(index, kind).some((agent) => agent.ready);
  const entries = index
    .contextEntries(contextId)
    .sort((a, b) => (a.createdAt ?? a.statusAt ?? 0) - (b.createdAt ?? b.statusAt ?? 0));
  const latest = entries.at(-1);
  if (!contextId || !latest) return create(ConversationSchema, { contextId, ready });
  const tree = taskTree(index, latest.parentTaskId || latest.id);
  return create(ConversationSchema, {
    contextId,
    ready,
    title: index.session(contextId)?.name ?? "",
    busy: tree ? busy(tree) : false,
    state: runState(latest),
    messages: messages(index, entries),
    pending: tree
      ? foreground(tree).flatMap((entry) =>
          entry.interactions.filter((item) => awaiting(item.state)),
        )
      : [],
    roleDraft: kind === ConversationKind.ROLE_BUILDER ? await roleDraft(sync, latest) : undefined,
  });
}
