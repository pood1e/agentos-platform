import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import postgres from "postgres";
import {
  type ExecutionBinding,
  ExecutionBindingSchema,
  type ExecutionIdentity,
  ExecutionIdentitySchema,
} from "../../gen/agentos/execution/v1/identity_pb.js";
import { envelope } from "./envelope.js";

interface Stored<T> {
  value: T;
  version: string;
}

export interface ExecutionStore {
  binding(id: string): Promise<Stored<ExecutionBinding> | undefined>;
  /** The binding followed by its ancestors, ending at the root when the chain is intact. */
  chain(id: string): Promise<ExecutionBinding[]>;
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

/** Delegation chains longer than this are rejected. */
export const chainLimit = 32;

interface BindingRow {
  session_id: string;
  root_session_id: string;
  parent_session_id: string;
  agent_namespace: string;
  agent_name: string;
  subject: string;
  write: boolean;
  capabilities: number[];
  revoked: boolean;
  version: string;
}

interface CredentialRow {
  subject: string;
  write: boolean;
  capabilities: number[];
  service: boolean;
  tokens: Buffer | null;
  version: string;
}

const bindingOf = (row: BindingRow) =>
  create(ExecutionBindingSchema, {
    sessionId: row.session_id,
    rootSessionId: row.root_session_id,
    parentSessionId: row.parent_session_id,
    agent: { namespace: row.agent_namespace, name: row.agent_name },
    subject: row.subject,
    write: row.write,
    capabilities: row.capabilities,
    revoked: row.revoked,
  });

const changed = () => new ConnectError("Execution state changed", Code.Aborted);
const invalid = () => new ConnectError("Execution state is invalid", Code.PermissionDenied);
const unavailable = () => {
  throw new ConnectError("Execution state is unavailable", Code.Unavailable);
};

/** Bindings are plain columns; each subject's access and refresh tokens are envelope-encrypted. */
export async function executionStore(uri: string, key: Uint8Array, workspace: string, ca?: string) {
  const sealing = envelope(key);
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
      await transaction`create table if not exists agentos_authorization.execution_bindings (
        workspace text not null, session_id text not null, root_session_id text not null,
        parent_session_id text not null, agent_namespace text not null, agent_name text not null,
        subject text not null, write boolean not null, capabilities integer[] not null,
        revoked boolean not null, version bigint not null default 1,
        primary key (workspace, session_id)
      )`;
      await transaction`create table if not exists agentos_authorization.credentials (
        workspace text not null, subject text not null, write boolean not null,
        capabilities integer[] not null, service boolean not null, tokens bytea,
        version bigint not null default 1, primary key (workspace, subject)
      )`;
    });
  } catch {
    await sql.end();
    throw new Error("Execution database is unavailable");
  }

  const context = (subject: string) => ({ workspace, kind: "credential", subject });
  async function identityOf(row: CredentialRow) {
    const identity = create(ExecutionIdentitySchema, {
      subject: row.subject,
      write: row.write,
      capabilities: row.capabilities,
      credential: { case: "service", value: true },
    });
    if (row.service) return identity;
    if (!row.tokens) throw invalid();
    const secret = fromBinary(
      ExecutionIdentitySchema,
      await sealing.open(row.tokens, context(row.subject)),
    );
    if (secret.credential.case !== "accessToken") throw invalid();
    identity.credential = secret.credential;
    identity.refreshToken = secret.refreshToken;
    return identity;
  }
  async function tokensOf(identity: ExecutionIdentity) {
    if (identity.credential.case === "service") return null;
    if (identity.credential.case !== "accessToken") throw invalid();
    const secret = create(ExecutionIdentitySchema, {
      credential: identity.credential,
      refreshToken: identity.refreshToken,
    });
    return sealing.seal(toBinary(ExecutionIdentitySchema, secret), context(identity.subject));
  }
  const bindingColumns = sql`session_id, root_session_id, parent_session_id, agent_namespace,
    agent_name, subject, write, capabilities, revoked, version::text`;

  return {
    async binding(id: string) {
      const [row] = await sql<BindingRow[]>`
        select ${bindingColumns} from agentos_authorization.execution_bindings
        where workspace=${workspace} and session_id=${id}
      `.catch(unavailable);
      return row ? { value: bindingOf(row), version: row.version } : undefined;
    },
    async chain(id: string) {
      const rows = await sql<BindingRow[]>`
        with recursive chain as (
          select ${bindingColumns}, 1 as depth from agentos_authorization.execution_bindings
          where workspace=${workspace} and session_id=${id}
          union all
          select ${sql`parent.session_id, parent.root_session_id, parent.parent_session_id,
            parent.agent_namespace, parent.agent_name, parent.subject, parent.write,
            parent.capabilities, parent.revoked, parent.version::text`}, chain.depth + 1
          from agentos_authorization.execution_bindings parent
          join chain on parent.session_id = chain.parent_session_id
          where parent.workspace=${workspace} and chain.session_id <> chain.root_session_id
            and chain.depth < ${chainLimit}
        )
        select * from chain order by depth
      `.catch(unavailable);
      return rows.map(bindingOf);
    },
    async bindings(ids: string[]) {
      if (!ids.length) return [];
      const rows = await sql<BindingRow[]>`
        select ${bindingColumns} from agentos_authorization.execution_bindings
        where workspace=${workspace} and session_id = any(${ids}::text[])
      `.catch(unavailable);
      return rows.map(bindingOf);
    },
    async identity(subject: string) {
      const [row] = await sql<CredentialRow[]>`
        select subject, write, capabilities, service, tokens, version::text
        from agentos_authorization.credentials where workspace=${workspace} and subject=${subject}
      `.catch(unavailable);
      return row ? { value: await identityOf(row), version: row.version } : undefined;
    },
    async saveBinding(value: ExecutionBinding, version?: string) {
      const rows = await (version
        ? sql`update agentos_authorization.execution_bindings set
              root_session_id=${value.rootSessionId}, parent_session_id=${value.parentSessionId},
              agent_namespace=${value.agent?.namespace ?? ""}, agent_name=${value.agent?.name ?? ""},
              subject=${value.subject}, write=${value.write},
              capabilities=${value.capabilities}::integer[], revoked=${value.revoked},
              version=version+1
            where workspace=${workspace} and session_id=${value.sessionId}
              and version=${version}::bigint
            returning version`
        : sql`insert into agentos_authorization.execution_bindings(workspace, session_id,
              root_session_id, parent_session_id, agent_namespace, agent_name, subject, write,
              capabilities, revoked)
            values(${workspace}, ${value.sessionId}, ${value.rootSessionId},
              ${value.parentSessionId}, ${value.agent?.namespace ?? ""}, ${value.agent?.name ?? ""},
              ${value.subject}, ${value.write}, ${value.capabilities}::integer[], ${value.revoked})
            on conflict do nothing returning version`
      ).catch(unavailable);
      if (!rows.length) throw changed();
    },
    async saveIdentity(value: ExecutionIdentity, version?: string) {
      const tokens = await tokensOf(value);
      const service = value.credential.case === "service";
      const rows = await (version
        ? sql`update agentos_authorization.credentials set write=${value.write},
              capabilities=${value.capabilities}::integer[], service=${service}, tokens=${tokens},
              version=version+1
            where workspace=${workspace} and subject=${value.subject}
              and version=${version}::bigint
            returning version`
        : sql`insert into agentos_authorization.credentials(workspace, subject, write,
              capabilities, service, tokens)
            values(${workspace}, ${value.subject}, ${value.write},
              ${value.capabilities}::integer[], ${service}, ${tokens})
            on conflict do nothing returning version`
      ).catch(unavailable);
      if (!rows.length) throw changed();
    },
    updateIdentity: (subject, update) =>
      sql.begin(async (transaction) => {
        const [row] = await transaction<CredentialRow[]>`
          select subject, write, capabilities, service, tokens, version::text
          from agentos_authorization.credentials where workspace=${workspace} and subject=${subject}
          for update
        `;
        if (!row) return undefined;
        const current = await identityOf(row);
        const identity = await update(current);
        if (identity.subject !== subject)
          throw new ConnectError("Execution subject changed", Code.PermissionDenied);
        if (identity !== current)
          await transaction`update agentos_authorization.credentials set write=${identity.write},
            capabilities=${identity.capabilities}::integer[],
            service=${identity.credential.case === "service"}, tokens=${await tokensOf(identity)},
            version=version+1
            where workspace=${workspace} and subject=${subject}`;
        return identity;
      }),
    close: () => sql.end({ timeout: 5 }),
  } satisfies ExecutionStore & { close: () => Promise<void> };
}
