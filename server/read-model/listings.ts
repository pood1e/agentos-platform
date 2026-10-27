import { create, fromBinary } from "@bufbuild/protobuf";
import type postgres from "postgres";
import { TaskState } from "../../gen/a2a_pb.js";
import type { ListTasksRequest } from "../../gen/agentos/console/v1/console_service_pb.js";
import { ConversationSummarySchema } from "../../gen/agentos/console/v1/conversation_pb.js";
import { InteractionSchema, TaskSummarySchema } from "../../gen/agentos/console/v1/task_pb.js";
import { normalizeTags } from "../tasks/tags.js";
import { decodeCursor, encodeCursor, type PageRequest } from "./page.js";
import type { ReadStore } from "./store.js";
import { stamp } from "./views/runs.js";

/** Whose execution trees a request reads: its subject, plus service work for administrators. */
export interface Viewer {
  subject: string;
  administrator: boolean;
  systemOnly?: boolean;
}

const settled = [TaskState.COMPLETED, TaskState.FAILED, TaskState.CANCELED, TaskState.REJECTED];
const waiting = [TaskState.INPUT_REQUIRED, TaskState.AUTH_REQUIRED];
const like = (needle: string) => `%${needle.replace(/[\\%_]/g, "\\$&")}%`;

function visible(sql: postgres.Sql, column: string, viewer: Viewer) {
  if (viewer.systemOnly) return sql`${sql(column)} like 'service:%'`;
  return viewer.administrator
    ? sql`(${sql(column)} = ${viewer.subject} or ${sql(column)} like 'service:%')`
    : sql`${sql(column)} = ${viewer.subject}`;
}

function after(sql: postgres.Sql, request: PageRequest, scope: string, id: string) {
  if (!request.pageToken) return sql`true`;
  const cursor = decodeCursor(request.pageToken, scope, request.query);
  return sql`(updated_at < ${Number(cursor.afterTime)} or (updated_at = ${Number(cursor.afterTime)}
    and ${sql(id)} > ${cursor.afterId}))`;
}

function page(
  rows: postgres.Row[],
  request: PageRequest,
  scope: string,
  id: (row: postgres.Row) => string,
) {
  const size = request.pageSize || 12;
  const last = rows.length > size ? rows[size - 1] : undefined;
  return {
    rows: rows.slice(0, size),
    nextPageToken: last
      ? encodeCursor(scope, request.query, { id: id(last), time: Number(last.updated_at) })
      : "",
  };
}

export function listings({ sql, workspace }: Pick<ReadStore, "sql" | "workspace">) {
  return {
    async conversations(viewer: Viewer, agentId: string, request: PageRequest) {
      const needle = request.query.trim().toLowerCase();
      const scope = `conversations:${agentId}`;
      const filter = () => sql`workspace = ${workspace} and agent_id = ${agentId}
        and ${visible(sql, "subject", viewer)} and search like ${like(needle)}`;
      const [rows, [count]] = await Promise.all([
        sql`select context_id, title, state, updated_at from agentos_read.conversations
          where ${filter()} and ${after(sql, request, scope, "context_id")}
          order by updated_at desc, context_id limit ${(request.pageSize || 12) + 1}`,
        sql`select count(*)::int as total from agentos_read.conversations where ${filter()}`,
      ]);
      const result = page(rows, request, scope, (row) => row.context_id);
      return {
        conversations: result.rows.map((row) =>
          create(ConversationSummarySchema, {
            contextId: row.context_id,
            title: row.title,
            state: row.state,
            updatedAt: stamp(Number(row.updated_at) || undefined),
          }),
        ),
        totalSize: count?.total ?? 0,
        nextPageToken: result.nextPageToken,
      };
    },
    async operations(
      viewer: Viewer,
      request: PageRequest & Partial<Pick<ListTasksRequest, "states" | "engineer" | "tags">>,
    ) {
      const needle = request.query.trim().toLowerCase();
      const states = [...new Set(request.states ?? [])].sort((a, b) => a - b);
      const tags = normalizeTags(request.tags ?? []);
      const engineer = request.engineer ?? "";
      const scope = `tasks:${JSON.stringify([states, engineer, tags, viewer.systemOnly === true])}`;
      const owned = () => sql`o.workspace = ${workspace} and ${visible(sql, "o.subject", viewer)}`;
      const filter = () => sql`${owned()}
        and (${!states.length} or o.state = any(${states}::int[]))
        and (${!engineer} or ${engineer} = any(o.members))
        and coalesce(t.tags, '{}') @> ${tags}::text[]
        and (o.search || ' ' || lower(array_to_string(coalesce(t.tags, '{}'), ' '))) like ${like(needle)}`;
      const from = () => sql`agentos_read.operations o left join agentos_console.task_tags t
        on t.workspace = o.workspace and t.task_id = o.task_id`;
      const [rows, [count], available] = await Promise.all([
        sql`select o.task_id, o.updated_at, o.summary, t.tags, t.version from ${from()}
          where ${filter()} and ${after(sql, request, scope, "o.task_id")}
          order by o.updated_at desc, o.task_id limit ${(request.pageSize || 12) + 1}`,
        sql`select count(*)::int as total from ${from()} where ${filter()}`,
        sql`select distinct unnest(t.tags) as tag from ${from()} where ${owned()} order by tag`,
      ]);
      const result = page(rows, request, scope, (row) => row.task_id);
      return {
        tasks: result.rows.map((row) =>
          Object.assign(fromBinary(TaskSummarySchema, row.summary), {
            tags: row.tags ?? [],
            tagsVersion: row.version === null ? "0" : String(row.version),
          }),
        ),
        totalSize: count?.total ?? 0,
        nextPageToken: result.nextPageToken,
        availableTags: available.map((row) => row.tag as string),
      };
    },
    /** Per-agent activity over the viewer's executions. */
    async agentActivity(viewer: Viewer) {
      const rows = await sql`select agent_id,
          count(*) filter (where not (state = any(${settled}::int[])))::int as active,
          coalesce(sum(call_count), 0)::int as calls,
          bool_or(pending_approval and not (state = any(${settled}::int[]))) as approval,
          bool_or(state = any(${waiting}::int[])) as interrupted
        from agentos_read.tasks where workspace = ${workspace} and ${visible(sql, "subject", viewer)}
        group by agent_id`;
      return new Map(
        rows.map((row) => [
          row.agent_id as string,
          {
            active: row.active as number,
            calls: row.calls as number,
            approval: !!row.approval,
            interrupted: !!row.interrupted,
          },
        ]),
      );
    },
    /** Administrators review approval material across the workspace. */
    async approvals(viewer: Viewer) {
      const rows = await sql`select interaction from agentos_read.approvals
        where workspace = ${workspace}
          and (${viewer.administrator} or ${visible(sql, "subject", viewer)})
        order by requested_at desc, id`;
      return rows.map((row) => fromBinary(InteractionSchema, row.interaction));
    },
  };
}
