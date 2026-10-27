import { randomUUID } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { expect, it as test } from "vitest";
import { CoordinationJobSchema } from "../gen/agentos/execution/v1/coordination_pb.js";
import {
  type Coordinator,
  coordinationQueue,
  startCoordination,
} from "../server/jobs/coordination.js";
import { environment, silent, until } from "./harness.js";

const it = test.skipIf(!process.env.CHANGE_TEST_DATABASE_URL);
const reference = create(CoordinationJobSchema, {
  taskId: "native-task",
  work: { case: "approvalId", value: "native-pause" },
});

it("serializes a business key across replicas and recovers after an external side effect", async () => {
  const workspace = randomUUID();
  const uri = process.env.CHANGE_TEST_DATABASE_URL ?? "";
  const first = await coordinationQueue(uri, workspace, silent);
  const second = await coordinationQueue(uri, workspace, silent);
  const env = await environment();
  let active = 0,
    peak = 0,
    attempts = 0,
    complete = false;
  const external = new Set<string>();
  const processor: Coordinator = {
    name: "approvals",
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
  await first.boss.updateQueue(first.queue("approvals"), { retryDelay: 0, retryBackoff: false });
  const stopFirst = await startCoordination(env.projection, first, [processor]);
  const stopSecond = await startCoordination(env.projection, second, [processor]);
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
  const jobs = await coordinationQueue(
    process.env.CHANGE_TEST_DATABASE_URL ?? "",
    randomUUID(),
    silent,
  );
  const env = await environment();
  let healthy = false,
    complete = false;
  const processor: Coordinator = {
    name: "approvals",
    select: () => [reference],
    async run() {
      if (!healthy) throw new Error("Provider is unavailable");
      complete = true;
      return;
    },
  };
  await jobs.boss.updateQueue(jobs.queue("approvals"), { retryLimit: 0 });
  const stop = await startCoordination(env.projection, jobs, [processor]);
  await env.reconcile.refresh();
  try {
    await until(async () => (await jobs.boss.previewRedrive(jobs.failed)).total > 0);
    const preview = await jobs.boss.previewRedrive(jobs.failed);
    expect(preview.destinations).toEqual([{ name: jobs.queue("approvals"), count: 1 }]);
    healthy = true;
    expect(await jobs.boss.redrive(jobs.failed)).toBe(1);
    await until(() => complete);
  } finally {
    await stop();
    await jobs.boss.stop();
    await env.close();
  }
});

it("recovers pending work after the producing instance stops", async () => {
  const workspace = randomUUID();
  const uri = process.env.CHANGE_TEST_DATABASE_URL ?? "";
  const producer = await coordinationQueue(uri, workspace, silent);
  await producer.boss.send(
    producer.queue("continuations"),
    { taskId: "root", childId: "child" },
    { singletonKey: "root:childId:child" },
  );
  await producer.boss.stop();
  const consumer = await coordinationQueue(uri, workspace, silent);
  const env = await environment([]);
  let consumed = false;
  const stop = await startCoordination(env.projection, consumer, [
    {
      name: "continuations",
      select: () => [],
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
