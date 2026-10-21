import type { TaskSummary } from "../../gen/agentos/console/v1/task_pb.js";
import { invalid } from "../shared/errors.js";

export type TaskTags = Pick<TaskSummary, "tags" | "tagsVersion">;

export interface TaskTagStore {
  read(ids: string[]): Promise<Map<string, TaskTags>>;
  save(id: string, tags: string[], version: string): Promise<TaskTags>;
}

export const emptyTags = (): TaskTags => ({ tags: [], tagsVersion: "0" });

export function normalizeTags(tags: string[]) {
  const normalized = tags.map((tag) => tag.trim().normalize("NFC"));
  if (
    normalized.length > 32 ||
    normalized.some((tag) => !tag || [...tag].length > 40 || /\p{C}/u.test(tag))
  )
    throw invalid("task.tagsInvalid");
  return [...new Set(normalized)].sort();
}
