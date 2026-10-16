import { fromJson, type JsonValue, toJson } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import postgres from "postgres";
import {
  type ChangeRequest,
  ChangeRequestSchema,
  PrepareChangeResponseSchema,
} from "../../gen/agentos/governance/v1/change_pb.js";
import { changeId, planHash } from "../shared/change-digest.js";

interface Row {
  id: string;
  request: JsonValue;
  ticket_id: string | null;
  plan_hash: string;
  execution_hash: string;
  prepared_at: Date | null;
  approval_version: string | null;
  claimed_at: Date | null;
  claimed_call_id: string | null;
  failed: boolean | null;
  output: JsonValue | null;
  reported_at: Date | null;
}

export const changeRequest = (row: Row) => fromJson(ChangeRequestSchema, row.request);

/** Durable operation correlation; the environment ITSM owns approval decisions. */
export class ChangeStore {
  private sql: postgres.Sql;
  constructor(url: string) {
    this.sql = postgres(url, { max: 4, connect_timeout: 10, onnotice: () => {} });
  }

  async initialize() {
    await this.sql`CREATE TABLE IF NOT EXISTS changes (
      id text PRIMARY KEY, request jsonb NOT NULL, plan_hash text NOT NULL,
      execution_hash text NOT NULL DEFAULT '', prepared_at timestamptz, approval_version text,
      ticket_id text UNIQUE,
      claimed_at timestamptz, claimed_call_id text, failed boolean, output jsonb, reported_at timestamptz
    )`;
    await this.sql`ALTER TABLE changes
      ADD COLUMN IF NOT EXISTS execution_hash text NOT NULL DEFAULT '',
      ADD COLUMN IF NOT EXISTS prepared_at timestamptz,
      ADD COLUMN IF NOT EXISTS approval_version text,
      ADD COLUMN IF NOT EXISTS claimed_call_id text,
      DROP COLUMN IF EXISTS review_session_id, DROP COLUMN IF EXISTS review_task_id,
      DROP COLUMN IF EXISTS expires_at`;
    await this.sql`CREATE TABLE IF NOT EXISTS change_calls (
      id text PRIMARY KEY, change_id text NOT NULL REFERENCES changes(id), request_hash text NOT NULL,
      finished_at timestamptz
    )`;
    await this.sql`INSERT INTO change_calls (id, change_id, request_hash, finished_at)
      SELECT id, id, plan_hash, CASE WHEN failed IS NOT NULL OR reported_at IS NOT NULL THEN now() END
      FROM changes ON CONFLICT (id) DO NOTHING`;
    await this.sql`UPDATE changes SET claimed_call_id = id
      WHERE claimed_at IS NOT NULL AND claimed_call_id IS NULL`;
    await this.sql`CREATE INDEX IF NOT EXISTS changes_execution_pending ON changes(execution_hash)
      WHERE claimed_at IS NULL AND failed IS NULL`;
  }

  async register(
    request: ChangeRequest,
    executionHash: string,
    createTicket: (id: string, hash: string) => Promise<string>,
    reusable: (row: Row) => Promise<boolean>,
  ) {
    const id = changeId(request.taskId, request.tool?.id ?? ""),
      hash = planHash(request),
      json = toJson(ChangeRequestSchema, request),
      preparation = request.preparation
        ? toJson(PrepareChangeResponseSchema, request.preparation)
        : null;
    const registered = await this.sql.begin(async (sql) => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${request.contextId}:${executionHash}`}, 0))`;
      const [invocation] = await sql<{ change_id: string; request_hash: string }[]>`
        SELECT change_id, request_hash FROM change_calls WHERE id = ${id}`;
      if (invocation) {
        if (invocation.request_hash !== hash)
          throw new ConnectError("An existing change cannot be modified", Code.FailedPrecondition);
        return invocation.change_id;
      }
      const [existing] = await sql<Row[]>`SELECT * FROM changes WHERE id = ${id} FOR UPDATE`;
      if (!existing) {
        const candidates = await sql<Row[]>`SELECT * FROM changes
          WHERE execution_hash = ${executionHash} AND request->>'contextId' = ${request.contextId}
          AND request->'preparation' = ${sql.json(preparation as postgres.JSONValue)}
          AND ticket_id IS NOT NULL AND claimed_at IS NULL AND failed IS NULL
          AND NOT EXISTS (SELECT 1 FROM change_calls WHERE change_id = changes.id AND finished_at IS NULL)
          FOR UPDATE`;
        for (const candidate of candidates) {
          if (!(await reusable(candidate))) continue;
          await sql`INSERT INTO change_calls (id, change_id, request_hash)
            VALUES (${id}, ${candidate.id}, ${hash})`;
          return candidate.id;
        }
      }
      await sql`INSERT INTO changes (id, request, plan_hash, execution_hash)
        VALUES (${id}, ${sql.json(json as postgres.JSONValue)}, ${hash}, ${executionHash})
        ON CONFLICT (id) DO NOTHING`;
      const [row] = await sql<Row[]>`SELECT * FROM changes WHERE id = ${id} FOR UPDATE`;
      if (!row || row.plan_hash !== hash)
        throw new ConnectError("An existing change cannot be modified", Code.FailedPrecondition);
      if (!row.execution_hash)
        await sql`UPDATE changes SET execution_hash = ${executionHash} WHERE id = ${id}`;
      if (!row.ticket_id) {
        const ticketId = await createTicket(id, hash);
        await sql`UPDATE changes SET ticket_id = ${ticketId} WHERE id = ${id}`;
      }
      await sql`INSERT INTO change_calls (id, change_id, request_hash) VALUES (${id}, ${id}, ${hash})`;
      return id;
    });
    return this.get(registered);
  }

  async get(id: string) {
    const [row] = await this.sql<Row[]>`SELECT * FROM changes WHERE id = ${id}
      OR id = (SELECT change_id FROM change_calls WHERE id = ${id})`;
    if (!row) throw new ConnectError("Change not found", Code.NotFound);
    return row;
  }

  async prepare(id: string, version: string) {
    const source = await this.get(id);
    await this.sql.begin(async (sql) => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${source.execution_hash}, 0))`;
      const active = await sql<Row[]>`SELECT * FROM changes
        WHERE execution_hash = ${source.execution_hash} AND id != ${source.id}
        AND prepared_at > now() - interval '5 minutes' AND claimed_at IS NULL AND failed IS NULL`;
      if (active.length)
        throw new ConnectError("An identical operation is already prepared", Code.AlreadyExists);
      const rows = await sql`UPDATE changes SET prepared_at = now(), approval_version = ${version}
        WHERE id = ${source.id} AND execution_hash != '' AND claimed_at IS NULL
        AND failed IS NULL
        AND EXISTS (SELECT 1 FROM change_calls WHERE change_id = ${source.id} AND finished_at IS NULL)
        RETURNING id`;
      if (!rows.length)
        throw new ConnectError(
          "Change has no active native call, has failed, or was already executed",
          Code.FailedPrecondition,
        );
    });
  }

  async claim(hash: string, verify: (row: Row) => Promise<void>) {
    return this.sql.begin(async (sql) => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${hash}, 0))`;
      const rows = await sql<Row[]>`SELECT * FROM changes
        WHERE execution_hash = ${hash} AND prepared_at > now() - interval '5 minutes'
        AND claimed_at IS NULL AND failed IS NULL FOR UPDATE`;
      if (rows.length !== 1)
        throw new ConnectError(
          "A unique prepared and approved change is required",
          Code.PermissionDenied,
        );
      const row = rows[0];
      if (!row) throw new Error("Missing prepared change");
      const calls = await sql<{ id: string }[]>`SELECT id FROM change_calls
        WHERE change_id = ${row.id} AND finished_at IS NULL FOR UPDATE`;
      if (calls.length !== 1)
        throw new ConnectError("A unique active native call is required", Code.PermissionDenied);
      await verify(row);
      const claimed =
        await sql`UPDATE changes SET claimed_at = now(), claimed_call_id = ${calls[0]?.id ?? ""}
        WHERE id = ${row.id} AND claimed_at IS NULL AND failed IS NULL
        AND prepared_at > now() - interval '5 minutes' RETURNING id`;
      if (!claimed.length)
        throw new ConnectError("Execution preparation expired", Code.PermissionDenied);
      return row.id;
    });
  }

  async result(id: string, failed: boolean, output: JsonValue) {
    const source = await this.get(id);
    return this.sql.begin(async (sql) => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${source.execution_hash}, 0))`;
      const [row] = await sql<Row[]>`SELECT * FROM changes WHERE id = ${source.id} FOR UPDATE`;
      if (!row) throw new Error("Missing change result");
      await sql`UPDATE change_calls SET finished_at = COALESCE(finished_at, now()) WHERE id = ${id}`;
      if (!row.claimed_at || row.claimed_call_id !== id) return false;
      await sql`UPDATE changes SET failed = ${failed}, output = ${sql.json(output as postgres.JSONValue)}
        WHERE id = ${row.id} AND failed IS NULL`;
      return !row.reported_at;
    });
  }

  async reported(id: string) {
    const row = await this.get(id);
    await this.sql`UPDATE changes SET reported_at = now() WHERE id = ${row.id}`;
  }

  close() {
    return this.sql.end({ timeout: 5 });
  }
}
