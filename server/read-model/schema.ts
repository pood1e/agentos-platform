import type postgres from "postgres";

/** Idempotent startup DDL of the task projection and its list summaries. */
export async function createSchema(sql: postgres.Sql) {
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext('agentos_read'))`;
    // Existing schemas are left untouched so startup never locks tables that writers use.
    const [present] = await tx`select to_regclass('agentos_read.tasks_context') is not null as ok`;
    if (present?.ok) return;
    await tx`create schema if not exists agentos_read`;
    await tx`revoke all on schema agentos_read from public`;
    await tx`create table if not exists agentos_read.agents (
      workspace text not null, id text not null, info jsonb not null, primary key (workspace, id))`;
    await tx`create table if not exists agentos_read.sessions (
      workspace text not null, id text not null, agent_id text not null, name text not null,
      updated_at bigint, root_session_id text, subject text, primary key (workspace, id))`;
    await tx`create table if not exists agentos_read.tasks (
      workspace text not null, id text not null, context_id text not null, agent_id text not null,
      root_session_id text, subject text, state integer not null, status_at bigint,
      call_count integer not null, pending_approval boolean not null, revision text not null,
      entry jsonb not null, primary key (workspace, id))`;
    await tx`create table if not exists agentos_read.messages (
      workspace text not null, message_id text not null, task_id text not null,
      primary key (workspace, message_id))`;
    await tx`create table if not exists agentos_read.watermarks (
      workspace text not null, tenant text not null, status_at bigint not null,
      primary key (workspace, tenant))`;
    await tx`create table if not exists agentos_read.conversations (
      workspace text not null, context_id text not null, root_session_id text not null,
      agent_id text not null, subject text not null, title text not null, search text not null,
      state integer not null, updated_at bigint not null, primary key (workspace, context_id))`;
    await tx`create table if not exists agentos_read.operations (
      workspace text not null, task_id text not null, root_session_id text not null,
      subject text not null, state integer not null, members text[] not null, search text not null,
      updated_at bigint not null, summary bytea not null, primary key (workspace, task_id))`;
    for (const table of ["sessions", "tasks", "conversations", "operations"])
      await tx`create index if not exists ${tx(`${table}_root`)}
        on ${tx(`agentos_read.${table}`)} (workspace, root_session_id)`;
    await tx`create index if not exists tasks_context on agentos_read.tasks (workspace, context_id)`;
  });
}
