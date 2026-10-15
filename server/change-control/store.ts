import { fromJson, type JsonValue, toJson } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import postgres from "postgres";
import {
  type ChangeRequest,
  ChangeRequestSchema,
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
  expires_at: Date;
  claimed_at: Date | null;
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
      ticket_id text UNIQUE, expires_at timestamptz NOT NULL,
      claimed_at timestamptz, failed boolean, output jsonb, reported_at timestamptz
    )`;
    await this.sql`ALTER TABLE changes
      ADD COLUMN IF NOT EXISTS execution_hash text NOT NULL DEFAULT '',
      ADD COLUMN IF NOT EXISTS prepared_at timestamptz,
      ADD COLUMN IF NOT EXISTS approval_version text,
      DROP COLUMN IF EXISTS review_session_id, DROP COLUMN IF EXISTS review_task_id`;
    await this.sql`CREATE INDEX IF NOT EXISTS changes_execution_pending ON changes(execution_hash)
      WHERE claimed_at IS NULL AND failed IS NULL`;
  }

  async register(
    request: ChangeRequest,
    executionHash: string,
    createTicket: (id: string, hash: string) => Promise<string>,
  ) {
    const id = changeId(request.taskId, request.tool?.id ?? ""),
      hash = planHash(request);
    await this.sql.begin(async (sql) => {
      await sql`INSERT INTO changes (id, request, plan_hash, execution_hash, expires_at)
        VALUES (${id}, ${sql.json(toJson(ChangeRequestSchema, request) as postgres.JSONValue)}, ${hash}, ${executionHash}, now() + interval '1 hour')
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
    });
    return this.get(id);
  }

  async get(id: string) {
    const [row] = await this.sql<Row[]>`SELECT * FROM changes WHERE id = ${id}`;
    if (!row) throw new ConnectError("Change not found", Code.NotFound);
    return row;
  }

  async prepare(id: string, version: string) {
    const source = await this.get(id);
    await this.sql.begin(async (sql) => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${source.execution_hash}, 0))`;
      const active = await sql<Row[]>`SELECT * FROM changes
        WHERE execution_hash = ${source.execution_hash} AND id != ${id}
        AND prepared_at > now() - interval '5 minutes' AND claimed_at IS NULL AND failed IS NULL AND expires_at > now()`;
      if (active.length)
        throw new ConnectError("An identical operation is already prepared", Code.AlreadyExists);
      const rows = await sql`UPDATE changes SET prepared_at = now(), approval_version = ${version}
        WHERE id = ${id} AND execution_hash != '' AND claimed_at IS NULL
        AND failed IS NULL AND expires_at > now() RETURNING id`;
      if (!rows.length)
        throw new ConnectError(
          "Change has expired or was already executed",
          Code.FailedPrecondition,
        );
    });
  }

  async claim(hash: string, verify: (row: Row) => Promise<void>) {
    return this.sql.begin(async (sql) => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${hash}, 0))`;
      const rows = await sql<Row[]>`SELECT * FROM changes
        WHERE execution_hash = ${hash} AND prepared_at > now() - interval '5 minutes'
        AND claimed_at IS NULL AND failed IS NULL AND expires_at > now() FOR UPDATE`;
      if (rows.length !== 1)
        throw new ConnectError(
          "A unique prepared and approved change is required",
          Code.PermissionDenied,
        );
      const row = rows[0];
      if (!row) throw new Error("Missing prepared change");
      await verify(row);
      const claimed = await sql`UPDATE changes SET claimed_at = now()
        WHERE id = ${row.id} AND claimed_at IS NULL AND failed IS NULL
        AND prepared_at > now() - interval '5 minutes' AND expires_at > now() RETURNING id`;
      if (!claimed.length)
        throw new ConnectError("Execution preparation expired", Code.PermissionDenied);
      return row.id;
    });
  }

  async result(id: string, failed: boolean, output: JsonValue) {
    await this
      .sql`UPDATE changes SET failed = ${failed}, output = ${this.sql.json(output as postgres.JSONValue)}
      WHERE id = ${id} AND failed IS NULL`;
    return !(await this.get(id)).reported_at;
  }

  async reported(id: string) {
    await this.sql`UPDATE changes SET reported_at = now() WHERE id = ${id}`;
  }

  close() {
    return this.sql.end({ timeout: 5 });
  }
}
