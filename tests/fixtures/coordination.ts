import { randomUUID } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import type { Coordinator } from "../../server/jobs/coordination.js";
import { coordinationQueue, startCoordination } from "../../server/jobs/coordination.js";
import type { KagentSync } from "../../server/read-model/sync.js";
import { continuations } from "../../server/team-sessions/continuation.js";

export async function startJobs(
  sync: KagentSync,
  log: FastifyBaseLogger,
  processors: Coordinator[],
) {
  const uri = process.env.CHANGE_TEST_DATABASE_URL;
  if (!uri) throw new Error("Coordination integration tests require PostgreSQL");
  const jobs = await coordinationQueue(uri, randomUUID(), log);
  const stop = await startCoordination(sync, jobs, processors);
  return async () => {
    await stop();
    await jobs.boss.stop({ graceful: true, timeout: 5_000 });
  };
}

export function startContinuations(
  sync: KagentSync,
  log: FastifyBaseLogger,
  authorize?: Parameters<typeof continuations>[1],
) {
  return startJobs(sync, log, [continuations(sync, authorize)]);
}
