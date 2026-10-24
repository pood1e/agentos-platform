import { create } from "@bufbuild/protobuf";
import {
  type ChatMessagePart,
  ChatMessagePartSchema,
} from "../../../gen/agentos/console/v1/conversation_pb.js";
import { ActivityState } from "../../../gen/agentos/execution/v1/state_pb.js";
import { millis } from "../decode/messages.js";
import type { TaskEntry } from "../entry.js";
import type { TaskIndex } from "../index.js";
import { taskActivity, terminal } from "../state.js";
import { busy, outcomeState, taskTree } from "../tree.js";
import { runSummary } from "./runs.js";

export function conversationWork(index: TaskIndex, entries: TaskEntry[]) {
  const runs = new Map<string, ReturnType<typeof runSummary>>();
  for (const entry of entries) {
    const tree = taskTree(index, entry.id);
    if (tree)
      for (const member of tree.entries)
        runs.set(member.id, runSummary(member, tree.background.has(member.id)));
  }
  return [...runs.values()];
}

/** Conversation status includes background work, unlike composer availability. */
export function conversationProgress(index: TaskIndex, contextId: string) {
  const entries = index.contextEntries(contextId);
  const runs = conversationWork(index, entries);
  const latest = entries.toSorted(
    (a, b) => (b.createdAt ?? b.statusAt ?? 0) - (a.createdAt ?? a.statusAt ?? 0),
  )[0];
  const tree = latest && taskTree(index, latest.id);
  const priority = [
    ActivityState.AWAITING_APPROVAL,
    ActivityState.AWAITING_INPUT,
    ActivityState.WORKING,
    ActivityState.SUBMITTED,
  ];
  const state =
    priority.find((state) => runs.some((run) => run.state === state)) ??
    (entries.some((entry) => {
      const work = taskTree(index, entry.id);
      return work && busy(work);
    })
      ? ActivityState.WORKING
      : tree
        ? taskActivity(outcomeState(tree))
        : ActivityState.IDLE);
  return {
    state,
    updatedAt: Math.max(0, ...runs.flatMap((run) => millis(run.updatedAt) ?? [])),
  };
}

/** Latest completed run in each delegated conversation. */
export function delegatedResults(index: TaskIndex, entry: TaskEntry, callId: string) {
  const call = entry.calls.find((item) => item.id === callId);
  const target = call && index.target(entry, call);
  const tree = target ? taskTree(index, target) : undefined;
  if (!tree) return [];
  const contexts = new Map<string, TaskEntry>();
  for (const member of tree.entries) {
    if (member.contextId === entry.contextId) continue;
    const previous = contexts.get(member.contextId);
    if (!previous || (member.statusAt ?? 0) >= (previous.statusAt ?? 0))
      contexts.set(member.contextId, member);
  }
  return [...contexts.values()]
    .filter((member) => terminal(member.state))
    .sort((a, b) => (a.statusAt ?? 0) - (b.statusAt ?? 0))
    .map((member) => ({ member, background: tree.background.has(member.id) }));
}

/** Only terminal child answers enter the transcript; native tool payloads stay in their icons. */
export function agentResults(index: TaskIndex, entry: TaskEntry, parts: ChatMessagePart[]) {
  return parts.flatMap((part) => {
    if (part.content.case !== "toolCall") return [part];
    const callId = part.content.value.id;
    return [
      part,
      ...delegatedResults(index, entry, callId)
        .filter(({ member }) => member.answer.trim())
        .map(({ member, background }) =>
          create(ChatMessagePartSchema, {
            id: `result:${callId}:${member.contextId}`,
            content: {
              case: "agentResult",
              value: { ...runSummary(member, background), output: member.answer },
            },
          }),
        ),
    ];
  });
}
