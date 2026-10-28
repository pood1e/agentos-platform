import { create } from "@bufbuild/protobuf";
import {
  type ChatMessagePart,
  ChatMessagePartSchema,
} from "../../../gen/agentos/console/v1/conversation_pb.js";
import { type Interaction, InteractionKind } from "../../../gen/agentos/console/v1/task_pb.js";
import { ActivityState } from "../../../gen/agentos/execution/v1/state_pb.js";
import { millis } from "../decode/messages.js";
import type { TaskEntry } from "../entry.js";
import type { TaskGraph } from "../graph.js";
import { taskActivity, terminal } from "../state.js";
import { busy, outcomeState, taskTree } from "../tree.js";
import type { interactionAnchors } from "./interaction-anchors.js";
import { runSummary } from "./runs.js";

export function conversationWork(graph: TaskGraph, entries: TaskEntry[]) {
  const runs = new Map<string, ReturnType<typeof runSummary>>();
  for (const entry of entries) {
    const tree = taskTree(graph, entry.id);
    if (tree)
      for (const member of tree.entries)
        runs.set(member.id, runSummary(member, tree.background.has(member.id)));
  }
  return [...runs.values()];
}

/** Conversation status includes background work, unlike composer availability. */
export function conversationProgress(graph: TaskGraph, contextId: string) {
  const entries = graph.contextEntries(contextId);
  const runs = conversationWork(graph, entries);
  const latest = entries.toSorted(
    (a, b) => (b.createdAt ?? b.statusAt ?? 0) - (a.createdAt ?? a.statusAt ?? 0),
  )[0];
  const tree = latest && taskTree(graph, latest.id);
  const priority = [
    ActivityState.AWAITING_APPROVAL,
    ActivityState.AWAITING_INPUT,
    ActivityState.WORKING,
    ActivityState.SUBMITTED,
  ];
  const state =
    priority.find((state) => runs.some((run) => run.state === state)) ??
    (entries.some((entry) => {
      const work = taskTree(graph, entry.id);
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

/** Completed results remain visible when the delegated conversation continues. */
export function delegatedResults(graph: TaskGraph, entry: TaskEntry, callId: string) {
  const call = entry.calls.find((item) => item.id === callId);
  const target = call && graph.target(entry, call);
  const tree = target ? taskTree(graph, target) : undefined;
  if (!tree) return [];
  return tree.entries
    .filter((member) => member.contextId !== entry.contextId && terminal(member.state))
    .sort((a, b) => (a.statusAt ?? 0) - (b.statusAt ?? 0) || a.id.localeCompare(b.id))
    .map((member) => ({ member, background: tree.background.has(member.id) }));
}

/** Only terminal child answers enter the transcript; native tool payloads stay in their icons. */
export function conversationParts(
  graph: TaskGraph,
  entry: TaskEntry,
  parts: ChatMessagePart[],
  interactions: Set<string>,
  anchors: ReturnType<typeof interactionAnchors> = new Map(),
) {
  const emitted = new Set<string>();
  function human(items: Interaction[]) {
    return items
      .toSorted((a, b) => (millis(a.requestedAt) ?? 0) - (millis(b.requestedAt) ?? 0))
      .flatMap((item) => {
        if (interactions.has(item.id)) return [];
        interactions.add(item.id);
        return [
          create(ChatMessagePartSchema, {
            id: `interaction:${item.id}`,
            content: { case: "interaction", value: item },
          }),
        ];
      });
  }
  const result = parts.flatMap((part) => {
    if (part.content.case !== "toolCall") return [part];
    const callId = part.content.value.id;
    const call = entry.calls.find((item) => item.id === callId);
    const target = call && graph.target(entry, call);
    const children = target ? (taskTree(graph, target)?.entries ?? []) : [];
    return [
      part,
      ...human(
        entry.interactions.filter((item) => {
          if (item.kind === InteractionKind.APPROVAL)
            return item.tools.some((tool) => tool.callId === callId);
          const at = millis(item.requestedAt);
          const call = entry.calls.findLast(
            (call) =>
              call.name === "ask_user" &&
              (at === undefined || call.startedAt === undefined || call.startedAt <= at),
          );
          return call?.id === callId;
        }),
      ),
      ...human(
        children
          .filter((member) => member.contextId !== entry.contextId)
          .flatMap((member) => member.interactions)
          .filter((item) => {
            const anchor = anchors.get(item.id);
            return !anchor || (anchor.entryId === entry.id && anchor.callId === callId);
          }),
      ),
      ...delegatedResults(graph, entry, callId)
        .filter(({ member }) => member.answer.trim() && !emitted.has(member.id))
        .map(({ member, background }) => {
          emitted.add(member.id);
          return create(ChatMessagePartSchema, {
            id: `result:${callId}:${member.id}`,
            content: {
              case: "agentResult",
              value: { ...runSummary(member, background), output: member.answer },
            },
          });
        }),
    ];
  });
  return [...result, ...human(entry.interactions)];
}
