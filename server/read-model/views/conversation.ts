import { create, fromJson, toJson } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import { Role } from "../../../gen/a2a_pb.js";
import {
  type ChatMessage,
  type ChatMessagePart,
  ChatMessageSchema,
  type Conversation,
  ConversationSchema,
  type ConversationSummary,
  ConversationSummarySchema,
} from "../../../gen/agentos/console/v1/conversation_pb.js";
import {
  type RoleDefinition,
  RoleDefinitionSchema,
} from "../../../gen/agentos/console/v1/role_pb.js";
import { ActivityState } from "../../../gen/agentos/execution/v1/state_pb.js";
import type { ResourceReference } from "../../../gen/kagent/api/v1/common_pb.js";
import { pool } from "../../kagent/clients.js";
import { agentKey } from "../agents.js";
import { toolCalls } from "../calls.js";
import { object } from "../decode/messages.js";
import { toolBaseName } from "../decode/tools.js";
import type { TaskEntry } from "../entry.js";
import type { TaskIndex } from "../index.js";
import { approvals } from "../interactions.js";
import { type PageRequest, pageOf } from "../page.js";
import type { KagentSync } from "../sync.js";
import { busy, taskTree } from "../tree.js";
import { chatParts } from "./chat-parts.js";
import { agentResults, conversationProgress, conversationWork } from "./conversation-work.js";
import { engineer } from "./engineers.js";
import { runState, stamp } from "./runs.js";
import { taskSummary } from "./task.js";

export function listConversations(
  index: TaskIndex,
  agent: Pick<ResourceReference, "namespace" | "name"> | undefined,
  request: PageRequest,
) {
  const id = agent ? agentKey(agent) : "";
  const needle = request.query.trim().toLowerCase();
  const matches = index
    .sessions()
    .filter((session) => session.agentId === id)
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
    .map((session) => {
      const progress = conversationProgress(index, session.id);
      return {
        session,
        state: progress.state,
        at: Math.max(session.updatedAt ?? 0, progress.updatedAt),
      };
    })
    .sort((a, b) => b.at - a.at || a.session.id.localeCompare(b.session.id));
  const page = pageOf(matches, request, `conversations:${id}`, (entry) => ({
    id: entry.session.id,
    time: entry.at,
  }));
  return {
    conversations: page.items.map(
      ({ session, at, state }): ConversationSummary =>
        create(ConversationSummarySchema, {
          contextId: session.id,
          title: session.name,
          updatedAt: stamp(at || undefined),
          state,
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
    const root = index.operationRoot(index.target(entry, call) ?? "");
    const tree = root && roots.has(root.id) ? taskTree(index, root.id) : undefined;
    return tree ? [taskSummary(index, tree)] : [];
  });
}

async function messages(sync: KagentSync, index: TaskIndex, entries: TaskEntry[]) {
  const parts = new Map<string, ChatMessagePart[]>();
  await pool(entries, 4, async (entry) => {
    const task = await sync.fullTask(entry.id);
    if (task) parts.set(entry.id, chatParts(task, entry.agentId));
  });
  const seen = new Set<string>();
  return entries.flatMap((entry): ChatMessage[] => {
    const turns = entry.userMessages
      .filter((message) => !seen.has(message.id))
      .map((message, position) => {
        seen.add(message.id);
        return create(ChatMessageSchema, {
          id: message.id,
          role: Role.USER,
          parts: [{ id: `text:${message.id}`, content: { case: "text", value: message.text } }],
          taskId: entry.id,
          tasks: position === 0 ? operations(index, entry) : [],
        });
      });
    const content = agentResults(index, entry, parts.get(entry.id) ?? []);
    return content.length
      ? [
          ...turns,
          create(ChatMessageSchema, {
            id: `answer:${entry.id}`,
            role: Role.AGENT,
            parts: content,
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
  agent: Pick<ResourceReference, "namespace" | "name"> | undefined,
  contextId: string,
  index: TaskIndex = sync.index,
): Promise<Conversation> {
  const member = agent ? index.agent(agentKey(agent)) : undefined;
  const ready = member?.ready ?? false;
  const entries = index
    .contextEntries(contextId)
    .sort((a, b) => (a.createdAt ?? a.statusAt ?? 0) - (b.createdAt ?? b.statusAt ?? 0));
  const latest = entries.at(-1);
  if (!contextId || !latest) return create(ConversationSchema, { contextId, ready });
  const tree = taskTree(index, latest.parentTaskId || latest.id);
  const runs = conversationWork(index, entries);
  const members = [...new Set(runs.map((run) => run.agentId))];
  return create(ConversationSchema, {
    contextId,
    ready,
    title: index.session(contextId)?.name ?? "",
    busy: tree ? busy(tree) : false,
    state: runState(latest),
    messages: await messages(sync, index, entries),
    interactions: [
      ...new Map(
        runs.flatMap((run) =>
          (index.entry(run.taskId)?.interactions ?? []).map((item) => [item.id, item] as const),
        ),
      ).values(),
    ],
    runs,
    participants: members.map((id) =>
      engineer(
        index,
        id,
        runs.filter((run) => run.agentId === id).flatMap((run) => index.entry(run.taskId) ?? []),
      ),
    ),
    roleDraft: member?.role === "role-builder" ? await roleDraft(sync, latest) : undefined,
  });
}
