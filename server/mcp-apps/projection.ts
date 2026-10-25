import { create } from "@bufbuild/protobuf";
import {
  type ChatMessagePart,
  ChatMessagePartSchema,
  type Conversation,
} from "../../gen/agentos/console/v1/conversation_pb.js";
import { ActivityState } from "../../gen/agentos/execution/v1/state_pb.js";
import type { TaskRun, ToolCall } from "../../gen/agentos/execution/v1/task_pb.js";
import type { KagentSync } from "../read-model/sync.js";
import { delegatedResults } from "../read-model/views/conversation-work.js";
import { taskRun } from "../read-model/views/run.js";

export async function projectAppViews(
  sync: KagentSync,
  view: Conversation,
  decorate: (calls: ToolCall[]) => Promise<void>,
) {
  async function contextCalls(run: TaskRun) {
    const calls: ToolCall[] = [];
    for (const entry of sync.index.contextEntries(run.contextId)) {
      const value = await taskRun(sync, entry.id);
      if (value) calls.push(...value.calls);
    }
    await decorate(calls);
    return calls.filter((call) => call.uiResourceUri);
  }
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
        part.content.value.calls = await contextCalls(part.content.value);
      if (part.content.case !== "toolCall") continue;
      const call = part.content.value;
      await decorate([call]);
      const entry = sync.index.entry(call.taskId);
      if (!entry) continue;
      for (const { member, background } of delegatedResults(sync.index, entry, call.id)) {
        if (existing.has(member.contextId)) continue;
        const run = await taskRun(sync, member.id);
        if (!run) continue;
        run.calls = await contextCalls(run);
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
    const calls = parts.flatMap((part) =>
      part.content.case === "toolCall"
        ? [part.content.value]
        : part.content.case === "agentResult"
          ? part.content.value.calls
          : [],
    );
    const latest = new Map<string, ToolCall>();
    for (const call of calls) {
      if (!call.uiResourceUri) continue;
      if (call.state === ActivityState.SUCCEEDED || !latest.has(call.uiResourceUri))
        latest.set(call.uiResourceUri, call);
    }
    for (const call of calls)
      if (call.uiResourceUri && latest.get(call.uiResourceUri) !== call) call.uiResourceUri = "";
    message.parts = parts;
  }
}
