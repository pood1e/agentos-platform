import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { VoiceMode } from "../../gen/agentos/console/v1/speech_pb.js";
import { unavailable } from "../shared/errors.js";

export interface VoiceSession {
  id: string;
  subject: string;
  mode: VoiceMode;
  languageCode: string;
  text: string;
  /** Empty until the first turn of a new call starts a conversation. */
  contextId: string;
}

// Dictation and read-aloud sessions only need to outlive agent dispatch.
const lifetime = (mode: VoiceMode) => (mode === VoiceMode.CALL ? 1800 : 120);

/** Each LiveKit room is one session, bound to its initiator, mode and conversation until it expires. */
export async function voiceSessions(uri: string, workspace: string, ca?: string) {
  const sql = postgres(uri, {
    max: 3,
    connect_timeout: 10,
    idle_timeout: 20,
    ...(ca ? { ssl: { ca, rejectUnauthorized: true } } : {}),
    onnotice: () => {},
  });
  try {
    await sql.begin(async (transaction) => {
      await transaction`select pg_advisory_xact_lock(hashtext('agentos_voice'))`;
      await transaction`create schema if not exists agentos_voice`;
      await transaction`revoke all on schema agentos_voice from public`;
      await transaction`create table if not exists agentos_voice.sessions (
        id uuid primary key, workspace text not null, subject text not null, mode smallint not null,
        language_code text not null, text text not null, context_id text not null,
        expires_at timestamptz not null
      )`;
    });
  } catch {
    await sql.end();
    throw new Error("Voice session database is unavailable");
  }
  const guarded = <T>(query: Promise<T>) =>
    query.catch(() => {
      throw unavailable();
    });
  return {
    async create(session: Omit<VoiceSession, "id">) {
      const id = randomUUID();
      await guarded(sql`delete from agentos_voice.sessions where expires_at < now()`);
      await guarded(sql`insert into agentos_voice.sessions
        (id, workspace, subject, mode, language_code, text, context_id, expires_at)
        values (${id}, ${workspace}, ${session.subject}, ${session.mode}, ${session.languageCode},
          ${session.text}, ${session.contextId},
          now() + make_interval(secs => ${lifetime(session.mode)}))`);
      return id;
    },
    async get(id: string) {
      const [row] = await guarded(sql<VoiceSession[]>`
        select id::text, subject, mode, language_code as "languageCode", text, context_id as "contextId"
        from agentos_voice.sessions
        where id = ${id}::uuid and workspace = ${workspace} and expires_at > now()`);
      return row;
    },
    async bind(id: string, contextId: string) {
      const rows = await guarded(sql`update agentos_voice.sessions set context_id = ${contextId}
        where id = ${id}::uuid and workspace = ${workspace} and context_id = '' and expires_at > now()
        returning id`);
      return rows.length > 0;
    },
    close: () => sql.end({ timeout: 5 }),
  };
}

export type VoiceSessions = Awaited<ReturnType<typeof voiceSessions>>;
