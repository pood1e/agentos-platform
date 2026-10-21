import { conflict } from "../../server/shared/errors.js";
import { normalizeTags, type TaskTagStore, type TaskTags } from "../../server/tasks/tags.js";

export function memoryTaskTags(): TaskTagStore {
  const values = new Map<string, TaskTags>();
  return {
    async read(ids) {
      return new Map(
        ids.flatMap((id) => {
          const value = values.get(id);
          return value ? [[id, structuredClone(value)] as const] : [];
        }),
      );
    },
    async save(id, tags, version) {
      if ((values.get(id)?.tagsVersion ?? "0") !== version) throw conflict("task.tagsConflict");
      const value = { tags: normalizeTags(tags), tagsVersion: String(Number(version) + 1) };
      values.set(id, value);
      return structuredClone(value);
    },
  };
}
