import { create } from "@bufbuild/protobuf";
import { Code } from "@connectrpc/connect";
import { expect, it } from "vitest";
import { ScheduledRunSchema } from "../gen/kagent/api/v1/scheduled_runs_pb.js";
import { consoleClient, environment } from "./harness.js";

const agent = { namespace: "agentos", name: "inspection" };
const config = {
  name: "Inspection",
  schedule: "*/30 * * * *",
  timeZone: "Asia/Shanghai",
  prompt: "Inspect the site",
};

it("manages the caller's workspace schedules through native ScheduledRuns", async () => {
  const env = await environment([]);
  const client = consoleClient(env);
  try {
    const { scheduledRun } = await client.createScheduledRun({ agent, requestId: "r1", config });
    const id = scheduledRun?.id ?? "";
    expect((await client.listScheduledRuns({})).scheduledRuns.map((run) => run.id)).toEqual([id]);
    const paused = await client.updateScheduledRun({
      scheduledRunId: id,
      etag: scheduledRun?.etag,
      config: { ...config, paused: true },
    });
    expect(paused.scheduledRun?.config?.paused).toBe(true);
    const { execution } = await client.triggerScheduledRun({ scheduledRunId: id, requestId: "t1" });
    expect(
      (await client.listScheduledRunExecutions({ scheduledRunId: id })).executions.map(
        (item) => item.id,
      ),
    ).toEqual([execution?.id]);
    await client.deleteScheduledRun({ scheduledRunId: id });
    expect((await client.listScheduledRuns({})).scheduledRuns).toEqual([]);
  } finally {
    await env.close();
  }
});

it("keeps schedules inside the workspace and behind background delegation", async () => {
  const env = await environment([]);
  const client = consoleClient(env);
  const foreign = create(ScheduledRunSchema, {
    id: "6a3f0e0e-5d8b-4bb4-9a43-3cb1c5a0d001",
    agent: { namespace: "foreign", name: "inspection" },
    config,
    etag: "e1",
  });
  env.fake.scheduledRuns.set(foreign.id, foreign);
  try {
    expect((await client.listScheduledRuns({})).scheduledRuns).toEqual([]);
    for (const call of [
      () => client.triggerScheduledRun({ scheduledRunId: foreign.id, requestId: "t1" }),
      () => client.listScheduledRunExecutions({ scheduledRunId: foreign.id }),
      () => client.createScheduledRun({ agent: foreign.agent, requestId: "r0", config }),
    ])
      await expect(call()).rejects.toMatchObject({ code: Code.NotFound });
    await expect(
      client.createScheduledRun({
        agent,
        requestId: "r1",
        config: { ...config, schedule: "hourly" },
      }),
    ).rejects.toMatchObject({ code: Code.InvalidArgument, rawMessage: "schedule.invalid" });
    const { scheduledRun } = await client.createScheduledRun({ agent, requestId: "r2", config });
    await expect(
      client.updateScheduledRun({
        scheduledRunId: scheduledRun?.id,
        etag: "00000000-0000-4000-8000-000000000000",
        config,
      }),
    ).rejects.toMatchObject({ code: Code.Aborted, rawMessage: "schedule.conflict" });
    env.fake.renewable = false;
    await expect(
      client.createScheduledRun({ agent, requestId: "r3", config }),
    ).rejects.toMatchObject({ code: Code.FailedPrecondition, rawMessage: "delegation.required" });
    expect((await client.getAccessProfile({})).profile?.delegated).toBe(false);
    await client.registerDelegationCredential({});
    expect((await client.getAccessProfile({})).profile?.delegated).toBe(true);
    await client.createScheduledRun({ agent, requestId: "r4", config });
  } finally {
    await env.close();
  }
});
