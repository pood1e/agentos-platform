import { create, fromJson, toJson } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import { Role, type Task } from "../../../gen/a2a_pb.js";
import {
  type ChatMessage,
  type ChatMessagePart,
  ChatMessageSchema,
  type Conversation,
  ConversationSchema,
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
import type { TaskEntry } from "../entry.js";
import type { TaskGraph } from "../graph.js";
import { approvals } from "../interactions.js";
import { busy, taskTree } from "../tree.js";
import { chatParts } from "./chat-parts.js";
import { conversationParts, conversationWork } from "./conversation-work.js";
import { engineer } from "./engineers.js";
import { interactionAnchors } from "./interaction-anchors.js";
import { runState } from "./runs.js";
import { taskSummary } from "./task.js";

/** Operations this conversation turn started: its own root or those it delegated to engineers. */
function operations(graph: TaskGraph, entry: TaskEntry) {
  const { roots, parents } = graph.relations();
  return roots
    .filter((root) => root.id === entry.id || parents.get(root.id) === entry.id)
    .flatMap((root) => {
      const tree = taskTree(graph, root.id);
      return tree ? [taskSummary(graph, tree)] : [];
    });
}

/** Complete task payloads, from a live stream while running or from kagent once settled. */
export type FullTask = (entry: TaskEntry) => Promise<Task | undefined>;

async function messages(fullTask: FullTask, graph: TaskGraph, entries: TaskEntry[]) {
  const parts = new Map<string, ChatMessagePart[]>();
  const anchors = interactionAnchors(graph, entries);
  await pool(entries, 4, async (entry) => {
    const task = await fullTask(entry);
    if (task) parts.set(entry.id, chatParts(task, entry.agentId));
  });
  const seen = new Set<string>();
  const interactions = new Set<string>();
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
          tasks: position === 0 ? operations(graph, entry) : [],
        });
      });
    const content = conversationParts(
      graph,
      entry,
      parts.get(entry.id) ?? [],
      interactions,
      anchors,
    );
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

async function roleDraft(
  fullTask: FullTask,
  entry: TaskEntry,
): Promise<RoleDefinition | undefined> {
  const call = entry.calls.findLast(
    (item) => item.name === "prepare_role" && item.state === ActivityState.SUCCEEDED,
  );
  const task = call && (await fullTask(entry));
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
  graph: TaskGraph,
  agent: Pick<ResourceReference, "namespace" | "name"> | undefined,
  contextId: string,
  fullTask: FullTask,
): Promise<Conversation> {
  const member = agent ? graph.agent(agentKey(agent)) : undefined;
  const ready = member?.ready ?? false;
  const entries = graph
    .contextEntries(contextId)
    .sort(
      (a, b) =>
        (a.createdAt ?? a.statusAt ?? 0) - (b.createdAt ?? b.statusAt ?? 0) ||
        a.id.localeCompare(b.id),
    );
  const latest = entries.at(-1);
  if (!contextId || !latest) return create(ConversationSchema, { contextId, ready });
  const root = graph.entry(latest.execution?.root?.taskId ?? "") ?? latest;
  const tree = taskTree(graph, root.id);
  const runs = conversationWork(graph, entries);
  const members = [...new Set(runs.map((run) => run.agentId))];
  return create(ConversationSchema, {
    contextId,
    ready,
    title: graph.session(contextId)?.name ?? "",
    busy: tree ? busy(tree) : false,
    state: runState(latest),
    messages: await messages(fullTask, graph, entries),
    interactions: [
      ...new Map(
        runs.flatMap((run) =>
          (graph.entry(run.taskId)?.interactions ?? []).map((item) => [item.id, item] as const),
        ),
      ).values(),
    ],
    runs,
    participants: members.map((id) =>
      engineer(
        graph,
        id,
        runs.filter((run) => run.agentId === id).flatMap((run) => graph.entry(run.taskId) ?? []),
      ),
    ),
    roleDraft: member?.role === "role-builder" ? await roleDraft(fullTask, latest) : undefined,
  });
}
