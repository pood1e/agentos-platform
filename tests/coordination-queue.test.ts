import { randomUUID } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { expect, it as test } from "vitest";
import { CoordinationJobSchema } from "../gen/agentos/execution/v1/coordination_pb.js";
import {
  type Coordinator,
  consumeCoordination,
  enqueueCoordination,
} from "../server/jobs/coordination.js";
import { jobQueue } from "../server/jobs/queue.js";
import { environment, silent, until } from "./harness.js";

const it = test.skipIf(!process.env.CHANGE_TEST_DATABASE_URL);
const reference = create(CoordinationJobSchema, {
  taskId: "native-task",
  work: { case: "childId", value: "native-child" },
});

it("serializes a business key across replicas and recovers after an external side effect", async () => {
  const workspace = randomUUID();
  const uri = process.env.CHANGE_TEST_DATABASE_URL ?? "";
  const first = await jobQueue(uri, workspace, silent, undefined, true);
  const second = await jobQueue(uri, workspace, silent, undefined, true);
  const env = await environment();
  let active = 0,
    peak = 0,
    attempts = 0,
    complete = false;
  const external = new Set<string>();
  const processor: Coordinator = {
    name: "continuations",
    select: () => (complete ? [] : [reference]),
    async run(job) {
      active++;
      peak = Math.max(peak, active);
      try {
        attempts++;
        external.add(job.taskId);
        await new Promise((resolve) => setTimeout(resolve, 100));
        if (attempts === 1) throw new Error("Process lost the response after the external commit");
        complete = true;
        return;
      } finally {
        active--;
      }
    },
  };
  await first.boss.updateQueue(first.queue("continuations"), {
    retryDelay: 0,
    retryBackoff: false,
  });
  enqueueCoordination(env.projection, first, [processor]);
  enqueueCoordination(env.projection, second, [processor]);
  const stopFirst = await consumeCoordination(first, [processor]);
  const stopSecond = await consumeCoordination(second, [processor]);
  await env.reconcile.refresh();
  try {
    await until(() => complete, 8_000);
    expect(peak).toBe(1);
    expect(external.size).toBe(1);
    expect(attempts).toBeGreaterThanOrEqual(2);
  } finally {
    await stopFirst();
    await stopSecond();
    await first.boss.stop();
    await second.boss.stop();
    await env.close();
  }
});

it("retains exhausted references and redrives them through the native dead-letter API", async () => {
  const jobs = await jobQueue(
    process.env.CHANGE_TEST_DATABASE_URL ?? "",
    randomUUID(),
    silent,
    undefined,
    true,
  );
  const env = await environment();
  let healthy = false,
    complete = false;
  const processor: Coordinator = {
    name: "continuations",
    select: () => [reference],
    async run() {
      if (!healthy) throw new Error("Provider is unavailable");
      complete = true;
      return;
    },
  };
  await jobs.boss.updateQueue(jobs.queue("continuations"), { retryLimit: 0 });
  enqueueCoordination(env.projection, jobs, [processor]);
  const stop = await consumeCoordination(jobs, [processor]);
  await env.reconcile.refresh();
  try {
    await until(async () => (await jobs.boss.previewRedrive(jobs.failed)).total > 0);
    const preview = await jobs.boss.previewRedrive(jobs.failed);
    expect(preview.destinations).toEqual([{ name: jobs.queue("continuations"), count: 1 }]);
    healthy = true;
    expect(await jobs.boss.redrive(jobs.failed)).toBe(1);
    await until(() => complete);
  } finally {
    await stop();
    await jobs.boss.stop();
    await env.close();
  }
});

it("runs work enqueued by a producing replica in a worker after the producer stops", async () => {
  const workspace = randomUUID();
  const uri = process.env.CHANGE_TEST_DATABASE_URL ?? "";
  const env = await environment();
  const producer = await jobQueue(uri, workspace, silent);
  const selected: Coordinator = {
    name: "continuations",
    select: () => [
      create(CoordinationJobSchema, { taskId: "root", work: { case: "childId", value: "child" } }),
    ],
    run: async () => undefined,
  };
  enqueueCoordination(env.projection, producer, [selected]);
  await env.reconcile.refresh();
  await producer.boss.stop();
  const consumer = await jobQueue(uri, workspace, silent, undefined, true);
  let consumed = false;
  const stop = await consumeCoordination(consumer, [
    {
      ...selected,
      async run(job) {
        expect(job.work).toEqual({ case: "childId", value: "child" });
        consumed = true;
        return;
      },
    },
  ]);
  try {
    await until(() => consumed);
  } finally {
    await stop();
    await consumer.boss.stop();
    await env.close();
  }
});
