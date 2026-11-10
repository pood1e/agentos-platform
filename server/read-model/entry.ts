import { Role, type Task, TaskState } from "../../gen/a2a_pb.js";
import type { Interaction } from "../../gen/agentos/console/v1/task_pb.js";
import type { TaskExecution } from "../../gen/kagent/api/v1/execution_pb.js";
import { type CallEntry, callEntries } from "./calls.js";
import { isHitlResponse } from "./decode/hitl.js";
import { createdMillis, messageText, statusMillis, timeline } from "./decode/messages.js";
import { taskOutput } from "./decode/output.js";
import { approvals, interactions } from "./interactions.js";

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
  prompt: string;
  messageIds: string[];
  userMessages: UserMessage[];
  answer: string;
  progress: string;
  calls: CallEntry[];
  interactions: Interaction[];
  execution?: TaskExecution;
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
  };
}
