import { create } from "@bufbuild/protobuf";
import { Role, type Task, TaskState } from "../../../gen/a2a_pb.js";
import {
  type ChatMessagePart,
  ChatMessagePartSchema,
} from "../../../gen/agentos/console/v1/conversation_pb.js";
import { toolCalls } from "../calls.js";
import { hitlPayload } from "../decode/hitl.js";
import { messageText, partTypeKey, taskSources, text } from "../decode/messages.js";
import { toolEvent, toolEventId } from "../decode/tools.js";
import { approvals } from "../interactions.js";

/** Native artifact order, with history-only tool events retained for other harnesses. */
function sources(task: Task) {
  const all = taskSources(task);
  const interactions = new Set(
    task.history
      .filter((message) => hitlPayload(message))
      .map((message) => `message:${message.messageId}`),
  );
  const artifacts = all.filter((source) => source.key.startsWith("artifact:"));
  const artifactCalls = new Set(
    artifacts.flatMap((source) =>
      source.parts.flatMap((part, index) => {
        const event = toolEvent(part);
        return event?.kind === "function_call" ? [toolEventId(event, source.key, index)] : [];
      }),
    ),
  );
  const hasText = artifacts.some((source) =>
    source.parts.some((part) => part.content.case === "text" && !part.metadata?.[partTypeKey]),
  );
  const history = all.filter(
    (source) =>
      source.key.startsWith("message:") &&
      source.narration &&
      !interactions.has(source.key) &&
      (!hasText ||
        source.parts.some((part, index) => {
          const event = toolEvent(part);
          return event && !artifactCalls.has(toolEventId(event, source.key, index));
        })),
  );
  const result = [...history, ...artifacts];
  return result.every((source) => source.at !== undefined)
    ? result.sort((a, b) => (a.at ?? 0) - (b.at ?? 0))
    : result;
}

export function chatParts(task: Task, agentId: string): ChatMessagePart[] {
  const calls = new Map(toolCalls(task, agentId, approvals(task)).map((call) => [call.id, call]));
  const parts: ChatMessagePart[] = [];
  const seen = new Set<string>();
  let id = "";
  let current = "";
  function flush() {
    if (current.trim())
      parts.push(
        create(ChatMessagePartSchema, { id, content: { case: "progress", value: current.trim() } }),
      );
    current = "";
    id = "";
  }
  for (const source of sources(task)) {
    for (const [index, part] of source.parts.entries()) {
      const kind = text(part.metadata?.[partTypeKey]);
      if (kind === "function_call" || kind === "function_response") {
        flush();
        const event = toolEvent(part);
        const key = event && toolEventId(event, source.key, index);
        const call = key && calls.get(key);
        if (call && !seen.has(call.id)) {
          seen.add(call.id);
          parts.push(
            create(ChatMessagePartSchema, {
              id: `call:${call.id}`,
              content: { case: "toolCall", value: call },
            }),
          );
        }
      } else if (part.content.case === "text") {
        id ||= `${source.key}:${index}`;
        current += part.content.value;
      }
    }
  }
  const final = current.trim();
  flush();
  const failure = task.status?.state === TaskState.FAILED ? messageText(task.status.message) : "";
  const last = parts.at(-1);
  if (failure && !(last?.content.case === "progress" && last.content.value === failure))
    parts.push(
      create(ChatMessagePartSchema, {
        id: `failure:${task.id}`,
        content: { case: "progress", value: failure },
      }),
    );
  if (task.status?.state === TaskState.COMPLETED) {
    if (final && last?.content.case === "progress") last.content = { case: "text", value: final };
    else {
      const message = task.history.findLast(
        (item) => item.role === Role.AGENT && !hitlPayload(item),
      );
      const answer = message?.parts.every((part) => !part.metadata?.[partTypeKey])
        ? messageText(message)
        : "";
      if (
        answer &&
        !parts.some((part) => part.content.case === "progress" && part.content.value === answer)
      )
        parts.push(
          create(ChatMessagePartSchema, {
            id: `final:${task.id}`,
            content: { case: "text", value: answer },
          }),
        );
    }
  }
  return parts;
}
