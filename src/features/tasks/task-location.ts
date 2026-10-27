import type { TaskSummary } from "../../../gen/agentos/console/v1/task_pb.js";
import { systemRunLocation } from "../system-tasks/location.js";

/** Chat operations open in their conversation; shared executions open in system tasks. */
export function taskLocation(
  task: Pick<TaskSummary, "conversationContextId" | "agent" | "contextId">,
) {
  return task.conversationContextId
    ? `/chat/${encodeURIComponent(task.conversationContextId)}`
    : systemRunLocation(task.agent?.name ?? "", task.contextId);
}
