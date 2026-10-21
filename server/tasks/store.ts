import postgres from "postgres";
import { conflict, unavailable } from "../shared/errors.js";
import { normalizeTags, type TaskTagStore, type TaskTags } from "./tags.js";

/** Task annotations use the platform database without changing native execution state. */
export async function taskTagStore(uri: string, workspace: string, ca?: string) {
  const sql = postgres(uri, {
    max: 3,
    connect_timeout: 10,
    idle_timeout: 20,
    ...(ca ? { ssl: { ca, rejectUnauthorized: true } } : {}),
    onnotice: () => {},
  });
  try {
    await sql.begin(async (transaction) => {
      await transaction`select pg_advisory_xact_lock(hashtext('agentos_console'))`;
      await transaction`create schema if not exists agentos_console`;
      await transaction`revoke all on schema agentos_console from public`;
      await transaction`create table if not exists agentos_console.task_tags (
        workspace text not null, task_id text not null, tags text[] not null,
        version bigint not null default 1, primary key (workspace, task_id)
      )`;
    });
  } catch {
    await sql.end();
    throw new Error("Task metadata database is unavailable");
  }
  return {
    async read(ids: string[]) {
      if (!ids.length) return new Map<string, TaskTags>();
      const rows = await sql<(TaskTags & { id: string })[]>`
        select task_id as id, tags, version::text as "tagsVersion"
        from agentos_console.task_tags
        where workspace=${workspace} and task_id = any(${ids}::text[])
      `.catch(() => {
        throw unavailable();
      });
      return new Map(rows.map(({ id, ...value }) => [id, value]));
    },
    async save(id: string, tags: string[], version: string) {
      tags = normalizeTags(tags);
      const rows = await (version === "0"
        ? sql<TaskTags[]>`insert into agentos_console.task_tags(workspace,task_id,tags)
            values(${workspace},${id},${tags}::text[]) on conflict do nothing
            returning tags, version::text as "tagsVersion"`
        : sql<
            TaskTags[]
          >`update agentos_console.task_tags set tags=${tags}::text[], version=version+1
            where workspace=${workspace} and task_id=${id} and version::text=${version}
            returning tags, version::text as "tagsVersion"`
      ).catch(() => {
        throw unavailable();
      });
      if (!rows[0]) throw conflict("task.tagsConflict");
      return rows[0];
    },
    close: () => sql.end({ timeout: 5 }),
  } satisfies TaskTagStore & { close: () => Promise<void> };
}
