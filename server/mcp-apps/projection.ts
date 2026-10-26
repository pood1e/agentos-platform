import { create } from "@bufbuild/protobuf";
import {
  type ChatMessagePart,
  ChatMessagePartSchema,
  type Conversation,
} from "../../gen/agentos/console/v1/conversation_pb.js";
import type { TaskRun, ToolCall } from "../../gen/agentos/execution/v1/task_pb.js";
import { pool } from "../kagent/clients.js";
import type { KagentSync } from "../read-model/sync.js";
import { delegatedResults } from "../read-model/views/conversation-work.js";
import { taskRun } from "../read-model/views/run.js";

export async function projectAppViews(
  sync: KagentSync,
  view: Conversation,
  decorate: (calls: ToolCall[]) => Promise<void>,
) {
  const contexts = new Set<string>();
  const direct: ToolCall[] = [];
  for (const message of view.messages)
    for (const part of message.parts) {
      if (part.content.case === "agentResult") contexts.add(part.content.value.contextId);
      if (part.content.case !== "toolCall") continue;
      const call = part.content.value;
      direct.push(call);
      const entry = sync.index.entry(call.taskId);
      if (entry)
        for (const { member } of delegatedResults(sync.index, entry, call.id))
          contexts.add(member.contextId);
    }
  const payloads = new Map<string, ToolCall[]>();
  await pool([...contexts], 4, async (contextId) => {
    const calls: ToolCall[] = [];
    for (const entry of sync.index.contextEntries(contextId)) {
      const value = await taskRun(sync, entry.id);
      if (value) calls.push(...value.calls);
    }
    payloads.set(contextId, calls);
  });
  await decorate([...direct, ...[...payloads.values()].flat()]);
  const contextCalls = (run: TaskRun) =>
    (payloads.get(run.contextId) ?? [])
      .filter((call) => call.uiResourceUri)
      .map((call) => ({ ...call }));
  for (const message of view.messages) {
    const parts: ChatMessagePart[] = [];
    const existing = new Set(
      message.parts.flatMap((part) =>
        part.content.case === "agentResult" ? [part.content.value.contextId] : [],
      ),
    );
    for (const part of message.parts) {
      parts.push(part);
      if (part.content.case === "agentResult")
        part.content.value.calls = contextCalls(part.content.value);
      if (part.content.case !== "toolCall") continue;
      const call = part.content.value;
      const entry = sync.index.entry(call.taskId);
      if (!entry) continue;
      for (const { member, background } of delegatedResults(sync.index, entry, call.id)) {
        if (existing.has(member.contextId)) continue;
        const run = await taskRun(sync, member.id);
        if (!run) continue;
        run.calls = contextCalls(run);
        if (!run.calls.length) continue;
        run.background = background;
        parts.push(
          create(ChatMessagePartSchema, {
            id: `result:${call.id}:${member.contextId}`,
            content: { case: "agentResult", value: run },
          }),
        );
        existing.add(member.contextId);
      }
    }
    message.parts = parts;
  }
}
