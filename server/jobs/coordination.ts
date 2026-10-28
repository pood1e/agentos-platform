import { fromJson, type JsonValue, toJson } from "@bufbuild/protobuf";
import {
  type CoordinationJob,
  CoordinationJobSchema,
} from "../../gen/agentos/execution/v1/coordination_pb.js";
import type { TaskGraph } from "../read-model/graph.js";
import type { TaskProjection } from "../read-model/projection.js";
import type { JobQueue } from "./queue.js";

export interface Coordinator {
  name: "continuations";
  /** Work for the changed tasks of one execution tree. */
  select(graph: TaskGraph, changed: ReadonlySet<string>): CoordinationJob[];
  run(reference: CoordinationJob): Promise<number | undefined>;
}

const key = (reference: CoordinationJob) =>
  `${reference.taskId}:${reference.work.case}:${reference.work.value}`;

/** Work is enqueued in the projection transaction that observed it, so no change is lost. */
export function enqueueCoordination(
  projection: Pick<TaskProjection, "hook">,
  { boss, queue }: JobQueue,
  coordinators: Pick<Coordinator, "name" | "select">[],
) {
  projection.hook(async (graph, changed, writer) => {
    const db = {
      executeSql: async (text: string, values: unknown[]) => ({
        rows: await writer.tx.unsafe(text, values as never[]),
      }),
    };
    for (const coordinator of coordinators)
      for (const reference of coordinator.select(graph, changed))
        await boss.send(
          queue(coordinator.name),
          toJson(CoordinationJobSchema, reference) as object,
          {
            singletonKey: key(reference),
            db,
          },
        );
  });
}

/** Workers process each business key alone and re-read native state before acting. */
export async function consumeCoordination({ boss, queue }: JobQueue, coordinators: Coordinator[]) {
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
    for (const worker of workers) await boss.offWork(worker.name, { id: worker.id });
  };
}
