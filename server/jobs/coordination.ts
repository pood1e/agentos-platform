import { fromJson, type JsonValue, toJson } from "@bufbuild/protobuf";
import type { FastifyBaseLogger } from "fastify";
import { PgBoss, type Queue } from "pg-boss";
import {
  type CoordinationJob,
  CoordinationJobSchema,
} from "../../gen/agentos/execution/v1/coordination_pb.js";
import type { KagentSync } from "../read-model/sync.js";

export interface Coordinator {
  name: "approvals" | "continuations";
  select(ids: ReadonlySet<string>): CoordinationJob[];
  run(reference: CoordinationJob): Promise<number | undefined>;
}

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
const key = (reference: CoordinationJob) =>
  `${reference.taskId}:${reference.work.case}:${reference.work.value}`;

export async function coordinationQueue(
  uri: string,
  workspace: string,
  log: Pick<FastifyBaseLogger, "error">,
  ca?: string,
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
    ...(ca ? { ssl: { ca, rejectUnauthorized: true } } : {}),
  });
  boss.on("error", (error) => log.error({ err: error }, "Coordination queue failed"));
  await boss.start();
  const queue = (name: string) => `${workspace}.${name}`;
  const failed = queue("failed");
  await boss.createQueue(failed, { retentionSeconds: 90 * 86400 });
  for (const name of ["approvals", "continuations"])
    await boss.createQueue(queue(name), { ...policy, deadLetter: failed });
  return { boss, queue, failed };
}

export async function startCoordination(
  sync: KagentSync,
  jobs: Awaited<ReturnType<typeof coordinationQueue>>,
  coordinators: Coordinator[],
) {
  const { boss, queue } = jobs;
  const send = (coordinator: Coordinator, reference: CoordinationJob) =>
    boss.send(queue(coordinator.name), toJson(CoordinationJobSchema, reference) as object, {
      singletonKey: key(reference),
    });
  const enqueue = async (ids: ReadonlySet<string>) => {
    for (const coordinator of coordinators)
      for (const reference of coordinator.select(ids)) await send(coordinator, reference);
  };
  const unsubscribe = sync.index.onCheckpoint(enqueue);
  // Native state reconstructs work on every process start, including after a failed enqueue.
  await enqueue(new Set(sync.index.all().map((entry) => entry.id)));
  const workers: { name: string; id: string }[] = [];
  for (const coordinator of coordinators) {
    const name = queue(coordinator.name);
    const id = await boss.work(
      name,
      { batchSize: 1, pollingIntervalSeconds: 0.5, transactional: true },
      async ([job], db) => {
        if (!job) return;
        const reference = fromJson(CoordinationJobSchema, job.data as JsonValue);
        const waiting = await coordinator.run(reference);
        if (waiting !== undefined)
          await boss.send(name, job.data as object, {
            singletonKey: key(reference),
            startAfter: waiting,
            db,
          });
      },
    );
    workers.push({ name, id });
  }
  return async () => {
    unsubscribe();
    for (const worker of workers) await boss.offWork(worker.name, { id: worker.id });
  };
}
