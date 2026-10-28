import type { TaskSummary } from "../../../gen/agentos/console/v1/task_pb.js";

/** Shared executions open their native transcript. */
export function taskLocation(
  task: Pick<TaskSummary, "conversationContextId" | "agent" | "contextId">,
) {
  return task.conversationContextId
    ? `/chat/${encodeURIComponent(task.conversationContextId)}`
    : `/executions/${encodeURIComponent(task.agent?.name ?? "")}/${encodeURIComponent(task.contextId)}`;
}
