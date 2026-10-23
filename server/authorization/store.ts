import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { fromBinary, type Message, toBinary } from "@bufbuild/protobuf";
import type { GenMessage } from "@bufbuild/protobuf/codegenv2";
import { Code, ConnectError } from "@connectrpc/connect";
import postgres from "postgres";
import {
  type ExecutionBinding,
  ExecutionBindingSchema,
  type ExecutionIdentity,
  ExecutionIdentitySchema,
} from "../../gen/agentos/execution/v1/identity_pb.js";

interface Stored<T> {
  value: T;
  version: string;
}

export interface ExecutionStore {
  binding(id: string): Promise<Stored<ExecutionBinding> | undefined>;
  bindings(ids: string[]): Promise<ExecutionBinding[]>;
  identity(subject: string): Promise<Stored<ExecutionIdentity> | undefined>;
  saveBinding(value: ExecutionBinding, version?: string): Promise<void>;
  saveIdentity(value: ExecutionIdentity, version?: string): Promise<void>;
  updateIdentity(
    subject: string,
    update: (identity: ExecutionIdentity) => Promise<ExecutionIdentity>,
  ): Promise<ExecutionIdentity | undefined>;
}

export const conflict = (error: unknown) =>
  error instanceof ConnectError && error.code === Code.Aborted;

/** Protobuf state is encrypted and authenticated against its database identity. */
export async function executionStore(uri: string, key: Uint8Array, workspace: string, ca?: string) {
  if (key.length !== 32) throw new Error("Execution encryption requires a 256-bit key");
  const sql = postgres(uri, {
    max: 5,
    connect_timeout: 10,
    idle_timeout: 20,
    ...(ca ? { ssl: { ca, rejectUnauthorized: true } } : {}),
    onnotice: () => {},
  });
  try {
    await sql.begin(async (transaction) => {
      await transaction`select pg_advisory_xact_lock(hashtext('agentos_authorization'))`;
      await transaction`create schema if not exists agentos_authorization`;
      await transaction`revoke all on schema agentos_authorization from public`;
      await transaction`create table if not exists agentos_authorization.objects (
        workspace text not null, kind text not null, id text not null, value bytea not null,
        version bigint not null default 1, primary key (workspace, kind, id)
      )`;
    });
  } catch {
    await sql.end();
    throw new Error("Execution database is unavailable");
  }

  const aad = (kind: string, id: string) => Buffer.from(JSON.stringify([workspace, kind, id]));
  function seal(bytes: Uint8Array, kind: string, id: string) {
    const nonce = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(aad(kind, id));
    const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]);
  }
  function open(bytes: Buffer, kind: string, id: string) {
    try {
      if (bytes.length < 28) throw new Error("Invalid ciphertext");
      const cipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
      cipher.setAAD(aad(kind, id));
      cipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]);
    } catch {
      throw new ConnectError("Execution state is invalid", Code.PermissionDenied);
    }
  }
  async function read<T extends Message>(schema: GenMessage<T>, kind: string, id: string) {
    const rows = await sql<{ value: Buffer; version: string }[]>`
      select value, version from agentos_authorization.objects where workspace=${workspace} and kind=${kind} and id=${id}
    `.catch(() => {
      throw new ConnectError("Execution state is unavailable", Code.Unavailable);
    });
    const row = rows[0];
    return row
      ? { value: fromBinary(schema, open(row.value, kind, id)), version: String(row.version) }
      : undefined;
  }
  async function save<T extends Message>(
    schema: GenMessage<T>,
    kind: string,
    id: string,
    value: T,
    version?: string,
  ) {
    const encrypted = seal(toBinary(schema, value), kind, id);
    const rows = await (version
      ? sql`update agentos_authorization.objects set value=${encrypted}, version=version+1
            where workspace=${workspace} and kind=${kind} and id=${id} and version=${version}::bigint returning version`
      : sql`insert into agentos_authorization.objects(workspace,kind,id,value) values(${workspace},${kind},${id},${encrypted})
            on conflict do nothing returning version`
    ).catch(() => {
      throw new ConnectError("Execution state could not be saved", Code.Unavailable);
    });
    if (!rows.length) throw new ConnectError("Execution state changed", Code.Aborted);
  }
  return {
    binding: (id: string) => read(ExecutionBindingSchema, "execution", id),
    async bindings(ids: string[]) {
      if (!ids.length) return [];
      const rows = await sql<{ id: string; value: Buffer }[]>`
        select id, value from agentos_authorization.objects
        where workspace=${workspace} and kind='execution' and id = any(${ids}::text[])
      `.catch(() => {
        throw new ConnectError("Execution state is unavailable", Code.Unavailable);
      });
      return rows.map((row) =>
        fromBinary(ExecutionBindingSchema, open(row.value, "execution", row.id)),
      );
    },
    identity: (id: string) => read(ExecutionIdentitySchema, "identity", id),
    saveBinding: (value: ExecutionBinding, version?: string) =>
      save(ExecutionBindingSchema, "execution", value.sessionId, value, version),
    saveIdentity: (value: ExecutionIdentity, version?: string) =>
      save(ExecutionIdentitySchema, "identity", value.subject, value, version),
    updateIdentity: (subject, update) =>
      sql.begin(async (transaction) => {
        const rows = await transaction<{ value: Buffer }[]>`
          select value from agentos_authorization.objects
          where workspace=${workspace} and kind='identity' and id=${subject} for update
        `;
        if (!rows[0]) return undefined;
        const current = fromBinary(
          ExecutionIdentitySchema,
          open(rows[0].value, "identity", subject),
        );
        const identity = await update(current);
        if (identity.subject !== subject)
          throw new ConnectError("Execution subject changed", Code.PermissionDenied);
        if (identity !== current) {
          const encrypted = seal(toBinary(ExecutionIdentitySchema, identity), "identity", subject);
          await transaction`update agentos_authorization.objects set value=${encrypted}, version=version+1
            where workspace=${workspace} and kind='identity' and id=${subject}`;
        }
        return identity;
      }),
    close: () => sql.end({ timeout: 5 }),
  } satisfies ExecutionStore & { close: () => Promise<void> };
}
