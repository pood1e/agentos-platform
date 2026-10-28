import type { FastifyBaseLogger } from "fastify";
import { PgBoss, type Queue } from "pg-boss";

const policy: Omit<Queue, "name"> = {
  policy: "stately",
  retryLimit: 12,
  retryDelay: 2,
  retryBackoff: true,
  retryDelayMax: 300,
  expireInSeconds: 900,
  retentionSeconds: 90 * 86400,
  deleteAfterSeconds: 90 * 86400,
};

/**
 * pg-boss queues in the execution database. Every replica enqueues; only workers
 * consume and run pg-boss maintenance.
 */
export async function jobQueue(
  uri: string,
  workspace: string,
  log: Pick<FastifyBaseLogger, "error">,
  ca?: string,
  consumer = false,
) {
  const connection = new URL(uri);
  if (ca)
    for (const option of ["sslmode", "sslcert", "sslkey", "sslrootcert"])
      connection.searchParams.delete(option);
  const boss = new PgBoss({
    connectionString: connection.toString(),
    schema: "agentos_jobs",
    max: 5,
    connectionTimeoutMillis: 10_000,
    supervise: consumer,
    schedule: false,
    ...(ca ? { ssl: { ca, rejectUnauthorized: true } } : {}),
  });
  boss.on("error", (error) => log.error({ err: error }, "Job queue failed"));
  await boss.start();
  const queue = (name: "approvals" | "continuations" | "presets" | "failed") =>
    `${workspace}.${name}`;
  const failed = queue("failed");
  await boss.createQueue(failed, { retentionSeconds: 90 * 86400 });
  for (const name of ["approvals", "continuations", "presets"] as const)
    await boss.createQueue(queue(name), { ...policy, deadLetter: failed });
  return { boss, queue, failed };
}

export type JobQueue = Awaited<ReturnType<typeof jobQueue>>;
