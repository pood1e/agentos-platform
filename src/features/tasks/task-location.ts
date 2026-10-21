import type { TaskSummary } from "../../../gen/agentos/console/v1/task_pb.js";

export function taskLocation(
  task: Pick<TaskSummary, "id" | "conversationContextId">,
  approval = false,
) {
  const search = new URLSearchParams({ task: task.id });
  if (approval) search.set("approval", "1");
  return `/chat${task.conversationContextId ? `/${encodeURIComponent(task.conversationContextId)}` : ""}?${search}`;
}
