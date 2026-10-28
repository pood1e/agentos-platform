import type { JsonObject } from "@bufbuild/protobuf";
import postgres from "postgres";
import type { AgentInfo, SessionInfo } from "./agents.js";
import { commandLocks } from "./commands.js";
import type { TaskEntry } from "./entry.js";
import { decodeEntry, encodeEntry, entryRevision } from "./record.js";
import { createSchema } from "./schema.js";
import { pendingApproval } from "./views/runs.js";

/** Execution tree and owner a native session belongs to, taken from its execution binding. */
export interface Owner {
  root: string;
  subject: string;
}

export interface ProjectionChange {
  /** Execution trees written in one transaction; empty when every tree may have changed. */
  roots: string[];
  /** Task IDs and `session:<id>` keys written in one transaction. */
  ids: string[];
}

const channel = "agentos_read";

/** PostgreSQL task projection for one workspace; summaries live in `summaries.ts`. */
export async function readStore(uri: string, workspace: string, ca?: string) {
  const options = {
    connect_timeout: 10,
    idle_timeout: 20,
    ...(ca ? { ssl: { ca, rejectUnauthorized: true } } : {}),
    onnotice: () => {},
  };
  const sql = postgres(uri, { ...options, max: 8 });
  // Command locks hold their connection while the command runs, apart from projection writes.
  const locks = postgres(uri, { ...options, max: 8 });
  try {
    await createSchema(sql);
  } catch (error) {
    await Promise.all([sql.end({ timeout: 1 }), locks.end({ timeout: 1 })]);
    throw error;
  }
  const entries = (rows: { entry: JsonObject }[]) => rows.map((row) => decodeEntry(row.entry));
  const sessions = (rows: postgres.Row[]): SessionInfo[] =>
    rows.map((row) => ({
      id: row.id,
      agentId: row.agent_id,
      name: row.name,
      updatedAt: row.updated_at === null ? undefined : Number(row.updated_at),
    }));

  const reader = (db: postgres.Sql | postgres.TransactionSql) => ({
    agents: async (): Promise<AgentInfo[]> =>
      (
        await db`select info from agentos_read.agents where workspace = ${workspace}
        order by id`
      ).map((row) => row.info as AgentInfo),
    /** Every task and session of the given execution trees. */
    async tree(roots: string[]) {
      const [tasks, known] = await Promise.all([
        db`select entry from agentos_read.tasks
          where workspace = ${workspace} and root_session_id = any(${roots})`,
        db`select * from agentos_read.sessions
          where workspace = ${workspace} and root_session_id = any(${roots})`,
      ]);
      return { entries: entries(tasks as never), sessions: sessions(known) };
    },
  });

  return {
    sql,
    workspace,
    ...reader(sql),
    async entry(id: string): Promise<(TaskEntry & Partial<Owner>) | undefined> {
      const [row] = await sql`select entry, root_session_id, subject from agentos_read.tasks
        where workspace = ${workspace} and id = ${id}`;
      return row
        ? { ...decodeEntry(row.entry), root: row.root_session_id, subject: row.subject }
        : undefined;
    },
    async session(id: string): Promise<(SessionInfo & Partial<Owner>) | undefined> {
      const [row] = await sql`select * from agentos_read.sessions
        where workspace = ${workspace} and id = ${id}`;
      return row
        ? { ...sessions([row])[0], root: row.root_session_id, subject: row.subject }
        : undefined;
    },
    async taskOfMessage(messageId: string) {
      const [row] = await sql`select task_id from agentos_read.messages
        where workspace = ${workspace} and message_id = ${messageId}`;
      return row?.task_id as string | undefined;
    },
    /** Listed status per task, to fetch only tasks that changed natively. */
    async statuses(ids: string[]) {
      const rows = await sql`select id, state, status_at, root_session_id from agentos_read.tasks
        where workspace = ${workspace} and id = any(${ids})`;
      return new Map(
        rows.map((row) => [
          row.id as string,
          { state: row.state as number, statusAt: row.status_at, rooted: !!row.root_session_id },
        ]),
      );
    },
    async tenants(): Promise<string[]> {
      const rows = await sql`select distinct agent_id from agentos_read.sessions
        where workspace = ${workspace}`;
      return rows.map((row) => row.agent_id);
    },
    async unknownSessions(): Promise<string[]> {
      const rows = await sql`select distinct t.context_id from agentos_read.tasks t
        where t.workspace = ${workspace} and not exists (select 1 from agentos_read.sessions s
          where s.workspace = t.workspace and s.id = t.context_id)`;
      return rows.map((row) => row.context_id);
    },
    async watermark(tenant: string) {
      const [row] = await sql`select status_at from agentos_read.watermarks
        where workspace = ${workspace} and tenant = ${tenant}`;
      return row ? Number(row.status_at) : undefined;
    },
    async setWatermark(tenant: string, statusAt: number) {
      await sql`insert into agentos_read.watermarks ${sql({ workspace, tenant, status_at: statusAt })}
        on conflict (workspace, tenant) do update set status_at = excluded.status_at`;
    },
    async setAgents(agents: AgentInfo[]) {
      return sql.begin(async (tx) => {
        const current = await reader(tx).agents();
        if (JSON.stringify(current) === JSON.stringify(agents)) return false;
        await tx`delete from agentos_read.agents where workspace = ${workspace}`;
        if (agents.length)
          await tx`insert into agentos_read.agents ${tx(
            agents.map((agent) => ({ workspace, id: agent.id, info: tx.json(agent as never) })),
          )}`;
        return true;
      });
    },
    /** One projection write; summaries and coordination join the same transaction. */
    write<T>(run: (tx: ReturnType<typeof writer>) => Promise<T>) {
      return sql.begin((tx) => run(writer(tx)));
    },
    /** Committed changes of this workspace; heartbeats carry no change and prove delivery. */
    listen(
      change: (change: ProjectionChange) => void,
      heartbeat: () => void,
      listening: () => void,
    ) {
      return sql.listen(
        channel,
        (payload) => {
          const message = JSON.parse(payload) as Partial<ProjectionChange> & { workspace: string };
          if (message.workspace !== workspace) return;
          if (message.roots) change({ roots: message.roots, ids: message.ids ?? [] });
          else heartbeat();
        },
        listening,
      );
    },
    heartbeat: () => sql`select pg_notify(${channel}, ${JSON.stringify({ workspace })})`,
    exclusive: commandLocks(locks, workspace),
    close: () => Promise.all([sql.end({ timeout: 5 }), locks.end({ timeout: 5 })]),
  };

  function writer(tx: postgres.TransactionSql) {
    return {
      tx,
      ...reader(tx),
      /** Stores changed entries and returns their IDs; payload-only changes are skipped. */
      async tasks(values: TaskEntry[], owners: ReadonlyMap<string, Owner>) {
        if (!values.length) return [];
        const rows = values.map((entry) => {
          const record = encodeEntry(entry);
          const owner = owners.get(entry.contextId);
          return {
            workspace,
            id: entry.id,
            context_id: entry.contextId,
            agent_id: entry.agentId,
            root_session_id: owner?.root ?? null,
            subject: owner?.subject ?? null,
            state: entry.state,
            status_at: entry.statusAt ?? null,
            call_count: entry.calls.length,
            pending_approval: pendingApproval(entry),
            revision: entryRevision(record),
            entry: tx.json(record as never),
          };
        });
        const changed = await tx`insert into agentos_read.tasks ${tx(rows)}
          on conflict (workspace, id) do update set context_id = excluded.context_id,
            agent_id = excluded.agent_id,
            root_session_id = coalesce(excluded.root_session_id, agentos_read.tasks.root_session_id),
            subject = coalesce(excluded.subject, agentos_read.tasks.subject),
            state = excluded.state, status_at = excluded.status_at,
            call_count = excluded.call_count, pending_approval = excluded.pending_approval,
            revision = excluded.revision, entry = excluded.entry
          where (agentos_read.tasks.revision <> excluded.revision
              or agentos_read.tasks.root_session_id is distinct from
                coalesce(excluded.root_session_id, agentos_read.tasks.root_session_id))
            -- Concurrent writers never replace a newer native status with an older one.
            and coalesce(excluded.status_at >= agentos_read.tasks.status_at, true)
          returning id`;
        const messages = values.flatMap((entry) =>
          entry.messageIds.map((message_id) => ({ workspace, message_id, task_id: entry.id })),
        );
        if (messages.length)
          await tx`insert into agentos_read.messages ${tx(messages)}
            on conflict (workspace, message_id) do update set task_id = excluded.task_id`;
        return changed.map((row) => row.id as string);
      },
      async sessions(values: SessionInfo[], owners: ReadonlyMap<string, Owner>) {
        if (!values.length) return [];
        const changed = await tx`insert into agentos_read.sessions ${tx(
          values.map((session) => ({
            workspace,
            id: session.id,
            agent_id: session.agentId,
            name: session.name,
            updated_at: session.updatedAt ?? null,
            root_session_id: owners.get(session.id)?.root ?? null,
            subject: owners.get(session.id)?.subject ?? null,
          })),
        )} on conflict (workspace, id) do update set agent_id = excluded.agent_id,
            name = excluded.name, updated_at = excluded.updated_at,
            root_session_id = coalesce(excluded.root_session_id, agentos_read.sessions.root_session_id),
            subject = coalesce(excluded.subject, agentos_read.sessions.subject)
          where (agentos_read.sessions.agent_id, agentos_read.sessions.name,
              agentos_read.sessions.updated_at, agentos_read.sessions.root_session_id)
            is distinct from (excluded.agent_id, excluded.name, excluded.updated_at,
              coalesce(excluded.root_session_id, agentos_read.sessions.root_session_id))
          returning id`;
        return changed.map((row) => `session:${row.id}`);
      },
      /** Rows stored before their session was bound join the tree once the binding exists. */
      async adopt(owners: ReadonlyMap<string, Owner>) {
        const adopted: string[] = [];
        for (const [context, owner] of owners) {
          const rows = await tx`update agentos_read.tasks
            set root_session_id = ${owner.root}, subject = ${owner.subject}
            where workspace = ${workspace} and context_id = ${context} and root_session_id is null
            returning id`;
          await tx`update agentos_read.sessions
            set root_session_id = ${owner.root}, subject = ${owner.subject}
            where workspace = ${workspace} and id = ${context} and root_session_id is null`;
          adopted.push(...rows.map((row) => row.id as string));
        }
        return adopted;
      },
      async contextOf(id: string) {
        const [row] = await tx`select context_id from agentos_read.tasks
          where workspace = ${workspace} and id = ${id}`;
        return row?.context_id as string | undefined;
      },
      async subjectOf(root: string) {
        const [row] = await tx`select subject from agentos_read.sessions
          where workspace = ${workspace} and root_session_id = ${root} and subject is not null
          union all select subject from agentos_read.tasks
          where workspace = ${workspace} and root_session_id = ${root} and subject is not null
          limit 1`;
        return row?.subject as string | undefined;
      },
      async rootsOf(contexts: string[]) {
        const rows = await tx`select distinct root_session_id from agentos_read.sessions
          where workspace = ${workspace} and id = any(${contexts}) and root_session_id is not null
          union select distinct root_session_id from agentos_read.tasks
          where workspace = ${workspace} and context_id = any(${contexts})
            and root_session_id is not null`;
        return rows.map((row) => row.root_session_id as string);
      },
      async remove(ids: string[]) {
        await tx`delete from agentos_read.messages
          where workspace = ${workspace} and task_id = any(${ids})`;
        const rows = await tx`delete from agentos_read.tasks
          where workspace = ${workspace} and id = any(${ids}) returning id`;
        return rows.map((row) => row.id as string);
      },
      async forget(sessionId: string) {
        const tasks = await tx`delete from agentos_read.tasks
          where workspace = ${workspace} and context_id = ${sessionId} returning id`;
        await tx`delete from agentos_read.messages
          where workspace = ${workspace} and task_id = any(${tasks.map((row) => row.id)})`;
        await tx`delete from agentos_read.sessions where workspace = ${workspace} and id = ${sessionId}`;
        return tasks.map((row) => row.id as string);
      },
      lock: (root: string) =>
        tx`select pg_advisory_xact_lock(hashtext(${`agentos_read:${workspace}:${root}`}))`,
      notify: (change: ProjectionChange) =>
        tx`select pg_notify(${channel}, ${JSON.stringify({ workspace, ...change })})`,
    };
  }
}

export type ReadStore = Awaited<ReturnType<typeof readStore>>;
export type ReadWriter = Parameters<Parameters<ReadStore["write"]>[0]>[0];
