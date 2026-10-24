import { create } from "@bufbuild/protobuf";
import {
  type ChatMessagePart,
  ChatMessagePartSchema,
} from "../../../gen/agentos/console/v1/conversation_pb.js";
import type { TaskEntry } from "../entry.js";
import type { TaskIndex } from "../index.js";
import { terminal } from "../state.js";
import { taskTree } from "../tree.js";
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

/** Only terminal child answers enter the transcript; native tool payloads stay in their icons. */
export function agentResults(index: TaskIndex, entry: TaskEntry, parts: ChatMessagePart[]) {
  return parts.flatMap((part) => {
    if (part.content.case !== "toolCall") return [part];
    const callId = part.content.value.id;
    const call = entry.calls.find((item) => item.id === callId);
    const target = call && index.target(entry, call);
    const tree = target ? taskTree(index, target) : undefined;
    if (!tree) return [part];
    const contexts = new Map<string, TaskEntry>();
    for (const member of tree.entries) {
      if (member.contextId === entry.contextId) continue;
      const previous = contexts.get(member.contextId);
      if (!previous || (member.statusAt ?? 0) >= (previous.statusAt ?? 0))
        contexts.set(member.contextId, member);
    }
    return [
      part,
      ...[...contexts.values()]
        .filter((member) => terminal(member.state) && member.answer.trim())
        .sort((a, b) => (a.statusAt ?? 0) - (b.statusAt ?? 0))
        .map((member) =>
          create(ChatMessagePartSchema, {
            id: `result:${callId}:${member.contextId}`,
            content: {
              case: "agentResult",
              value: {
                ...runSummary(member, tree.background.has(member.id)),
                output: member.answer,
              },
            },
          }),
        ),
    ];
  });
}
