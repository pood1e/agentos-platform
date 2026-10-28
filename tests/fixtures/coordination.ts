import { randomUUID } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import {
  type Coordinator,
  consumeCoordination,
  enqueueCoordination,
} from "../../server/jobs/coordination.js";
import { jobQueue } from "../../server/jobs/queue.js";
import type { TaskProjection } from "../../server/read-model/projection.js";
import { continuations } from "../../server/team-sessions/continuation.js";

/** Starts coordination before the projection observes native state, as the platform does. */
export async function startJobs(
  projection: TaskProjection,
  log: FastifyBaseLogger,
  processors: Coordinator[],
) {
  const uri = process.env.CHANGE_TEST_DATABASE_URL;
  if (!uri) throw new Error("Coordination integration tests require PostgreSQL");
  const jobs = await jobQueue(uri, randomUUID(), log, undefined, true);
  enqueueCoordination(projection, jobs, processors);
  const stop = await consumeCoordination(jobs, processors);
  return async () => {
    await stop();
    await jobs.boss.stop({ graceful: true, timeout: 5_000 });
  };
}

export function startContinuations(
  projection: TaskProjection,
  log: FastifyBaseLogger,
  authorize?: Parameters<typeof continuations>[1],
) {
  return startJobs(projection, log, [continuations(projection, authorize)]);
}
