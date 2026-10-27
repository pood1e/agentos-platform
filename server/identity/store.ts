import type { Adapter, AdapterPayload } from "oidc-provider";
import postgres from "postgres";

/** oidc-provider artifacts keyed by model name; expired rows are invisible and pruned periodically. */
export async function artifactStore(uri: string, ca?: string) {
  const sql = postgres(uri, {
    max: 4,
    connect_timeout: 10,
    idle_timeout: 20,
    ...(ca ? { ssl: { ca, rejectUnauthorized: true } } : {}),
    onnotice: () => {},
  });
  await sql.begin(async (transaction) => {
    await transaction`select pg_advisory_xact_lock(hashtext('agentos_identity'))`;
    // Existing schemas are left untouched so startup never locks tables that writers use.
    const [present] =
      await transaction`select to_regclass('agentos_identity.artifacts_grant') is not null as ok`;
    if (present?.ok) return;
    await transaction`create schema if not exists agentos_identity`;
    await transaction`create table if not exists agentos_identity.artifacts (
      model text not null,
      id text not null,
      payload jsonb not null,
      grant_id text,
      uid text,
      user_code text,
      expires_at timestamptz,
      primary key (model, id))`;
    await transaction`create index if not exists artifacts_grant
      on agentos_identity.artifacts (grant_id) where grant_id is not null`;
  });
  const first = async (rows: Promise<{ payload: AdapterPayload }[]>) => (await rows)[0]?.payload;
  const prune = setInterval(() => {
    sql`delete from agentos_identity.artifacts where expires_at < now()`.catch(() => {});
  }, 3_600_000);
  prune.unref();

  const adapter = (model: string): Adapter => ({
    async upsert(id, payload, expiresIn) {
      const row = {
        model,
        id,
        payload: sql.json(payload as postgres.JSONValue),
        grant_id: payload.grantId ?? null,
        uid: payload.uid ?? null,
        user_code: payload.userCode ?? null,
        expires_at: expiresIn ? new Date(Date.now() + expiresIn * 1000) : null,
      };
      await sql`insert into agentos_identity.artifacts ${sql(row)}
        on conflict (model, id) do update set payload = excluded.payload,
          grant_id = excluded.grant_id, uid = excluded.uid,
          user_code = excluded.user_code, expires_at = excluded.expires_at`;
    },
    find: (id) =>
      first(sql`select payload from agentos_identity.artifacts
        where model = ${model} and id = ${id} and (expires_at is null or expires_at > now())`),
    findByUid: (uid) =>
      first(sql`select payload from agentos_identity.artifacts
        where model = ${model} and uid = ${uid} and (expires_at is null or expires_at > now())`),
    findByUserCode: (userCode) =>
      first(sql`select payload from agentos_identity.artifacts
        where model = ${model} and user_code = ${userCode} and (expires_at is null or expires_at > now())`),
    async consume(id) {
      await sql`update agentos_identity.artifacts
        set payload = payload || jsonb_build_object('consumed', extract(epoch from now())::bigint)
        where model = ${model} and id = ${id}`;
    },
    async destroy(id) {
      await sql`delete from agentos_identity.artifacts where model = ${model} and id = ${id}`;
    },
    async revokeByGrantId(grantId) {
      await sql`delete from agentos_identity.artifacts where grant_id = ${grantId}`;
    },
  });
  return {
    adapter,
    async close() {
      clearInterval(prune);
      await sql.end({ timeout: 5 });
    },
  };
}
