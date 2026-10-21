import { consoleClient } from "../../lib/console.js";
import { useWatch } from "../../lib/use-watch.js";

export function useTask(taskId: string) {
  return useWatch(taskId || undefined, async function* (signal) {
    for await (const { task } of consoleClient.watchTask({ taskId }, { signal }))
      if (task) yield task;
  });
}
