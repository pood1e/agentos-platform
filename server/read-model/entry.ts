import { createHash } from "node:crypto";
import { toBinary } from "@bufbuild/protobuf";
import { Role, type Task, TaskSchema, TaskState } from "../../gen/a2a_pb.js";
import type { Interaction } from "../../gen/agentos/console/v1/task_pb.js";
import { type CallEntry, callEntries } from "./calls.js";
import { hitlPayload, isHitlResponse } from "./decode/hitl.js";
import {
  createdMillis,
  messageText,
  metadataText,
  parentTaskKey,
  partTypeKey,
  resumedTaskKey,
  statusMillis,
  text,
  timeline,
} from "./decode/messages.js";
import { approvals, type Decision, interactions, latestDecision } from "./interactions.js";

export interface UserMessage {
  id: string;
  text: string;
}

/** Compact projection of one A2A task; full payloads are reloaded on demand. */
export interface TaskEntry {
  id: string;
  contextId: string;
  agentId: string;
  state: TaskState;
  statusAt?: number;
  createdAt?: number;
  version: string;
  prompt: string;
  messageIds: string[];
  userMessages: UserMessage[];
  answer: string;
  calls: CallEntry[];
  interactions: Interaction[];
  managedApprovals?: string[];
  reviewOfTaskId?: string;
  reviewRequestId?: string;
  parentTaskId: string;
  resumedTaskId: string;
  decision?: Decision;
}

/** Final text after the last tool activity, as kagent streams it into artifacts. */
function output(task: Task): string {
  let result = "";
  for (const part of task.artifacts.flatMap((artifact) => artifact.parts)) {
    const kind = text(part.metadata?.[partTypeKey]);
    if (kind === "function_call" || kind === "function_response") result = "";
    else if (part.content.case === "text") result += part.content.value;
  }
  return result.trim();
}

export function taskVersion(task: Task): string {
  return createHash("sha256").update(toBinary(TaskSchema, task)).digest("base64url");
}

const firstMetadata = (task: Task, key: string) =>
  task.history.map((message) => metadataText(message, key)).find(Boolean) ?? "";

export function ingest(task: Task, agentId: string): TaskEntry {
  const calls = callEntries(task, approvals(task));
  const users = task.history.filter((message) => message.role === Role.USER);
  const timelines = [...task.history, ...task.artifacts]
    .map((item) => timeline(item.metadata))
    .filter((value): value is number => value !== undefined);
  return {
    id: task.id,
    contextId: task.contextId,
    agentId,
    state: task.status?.state ?? TaskState.UNSPECIFIED,
    statusAt: statusMillis(task),
    createdAt: createdMillis(task) ?? (timelines.length ? Math.min(...timelines) : undefined),
    version: taskVersion(task),
    prompt: messageText(users[0]),
    messageIds: users.map((message) => message.messageId),
    userMessages: users
      .filter((message) => !metadataText(message, parentTaskKey) && !isHitlResponse(message))
      .flatMap((message) => {
        const value = messageText(message);
        return value ? [{ id: message.messageId, text: value }] : [];
      }),
    answer:
      (task.status?.state === TaskState.FAILED ? messageText(task.status.message) : "") ||
      output(task) ||
      messageText(
        task.history.findLast((message) => message.role === Role.AGENT && !hitlPayload(message)),
      ),
    calls,
    interactions: interactions(task, agentId, calls),
    managedApprovals: task.history.flatMap((message) => {
      const id = metadataText(message, "agentos.dev/approval-request");
      return id ? [id] : [];
    }),
    parentTaskId: firstMetadata(task, parentTaskKey),
    reviewOfTaskId: firstMetadata(task, "agentos.dev/review-task"),
    reviewRequestId: firstMetadata(task, "agentos.dev/review-request"),
    resumedTaskId: firstMetadata(task, resumedTaskKey),
    decision: latestDecision(task),
  };
}
