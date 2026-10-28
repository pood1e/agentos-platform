import postgres from "postgres";

const timeout = 5_000;

/**
 * Elects one replica through a session advisory lock on a dedicated connection.
 * The lock ends with its session, so a reconnected backend acquires it again.
 */
export function advisoryLease(database: { uri: string; ca?: string }, name: string) {
  const sql = postgres(database.uri, {
    max: 1,
    idle_timeout: 0,
    max_lifetime: null,
    connect_timeout: 10,
    ...(database.ca ? { ssl: { ca: database.ca, rejectUnauthorized: true } } : {}),
    onnotice: () => {},
  });
  let owner: number | undefined;
  async function bounded<T>(query: postgres.PendingQuery<postgres.Row[]>) {
    const timer = setTimeout(() => query.cancel(), timeout);
    try {
      return (await query) as unknown as T;
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    async held() {
      try {
        const [session] = await bounded<{ pid: number }[]>(sql`select pg_backend_pid() as pid`);
        if (session?.pid === owner) return true;
        const [lock] = await bounded<{ locked: boolean }[]>(
          sql`select pg_try_advisory_lock(hashtextextended(${name}, 0)) as locked`,
        );
        owner = lock?.locked ? session?.pid : undefined;
        return owner !== undefined;
      } catch {
        owner = undefined;
        return false;
      }
    },
    async release() {
      owner = undefined;
      await sql.end({ timeout: 5 });
    },
  };
}
