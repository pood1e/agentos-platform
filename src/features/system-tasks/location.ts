export function systemTaskLocation(taskId: string) {
  return `/system-tasks?${new URLSearchParams({ task: taskId })}`;
}
