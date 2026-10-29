import { createHash } from "node:crypto";
import { toBinary } from "@bufbuild/protobuf";
import { Role, type Task, TaskSchema, TaskState } from "../../gen/a2a_pb.js";
import type { Interaction } from "../../gen/agentos/console/v1/task_pb.js";
import type { TaskExecution } from "../../gen/kagent/api/v1/execution_pb.js";
import { type CallEntry, callEntries } from "./calls.js";
import { isHitlResponse } from "./decode/hitl.js";
import { createdMillis, messageText, statusMillis, timeline } from "./decode/messages.js";
import { taskOutput } from "./decode/output.js";
import { approvals, type Decision, interactions, latestDecision } from "./interactions.js";

interface UserMessage {
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
  progress: string;
  calls: CallEntry[];
  interactions: Interaction[];
  execution?: TaskExecution;
  decision?: Decision;
}

function taskVersion(task: Task): string {
  return createHash("sha256").update(toBinary(TaskSchema, task)).digest("base64url");
}

export function ingest(task: Task, agentId: string, execution?: TaskExecution): TaskEntry {
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
      .filter(
        (message) =>
          !message.messageId.startsWith("kagent-continuation-") && !isHitlResponse(message),
      )
      .flatMap((message) => {
        const value = messageText(message);
        return value ? [{ id: message.messageId, text: value }] : [];
      }),
    ...taskOutput(task),
    calls,
    interactions: interactions(task, agentId, calls),
    execution,
    decision: latestDecision(task),
  };
}
