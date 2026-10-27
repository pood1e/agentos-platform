import { randomUUID } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { expect, it, onTestFinished } from "vitest";
import { GetScheduledRunExecutionResultRequestSchema } from "../gen/agentos/automation/v1/service_pb.js";
import { scheduledExecutionResult } from "../server/automation/results.js";
import { bindTasks, environment } from "./harness.js";

async function setup() {
  const env = await environment([]);
  onTestFinished(() => env.close());
  const schedule = (await env.clients.schedules.listScheduledRuns({})).scheduledRuns[0];
  if (!schedule) throw new Error("Missing native schedule");
  const { execution } = await env.clients.schedules.triggerScheduledRun({
    scheduledRunId: schedule.id,
    requestId: randomUUID(),
  });
  if (!execution) throw new Error("Missing native execution");
  await bindTasks(env.store, env.fake, [...env.fake.tasks.values()], "service:schedule");
  await env.reconcile.refresh();
  const request = create(GetScheduledRunExecutionResultRequestSchema, {
    executionId: execution.id,
    page: { limit: 1 },
  });
  return { ...env, schedule, execution, request };
}

it("reads native execution results only after schedule authorization and rejects foreign workspaces", async () => {
  const f = await setup(),
    seen: string[] = [];
  const result = await scheduledExecutionResult(
    f.clients,
    f.projection,
    "agentos",
    f.request,
    async (id) => {
      seen.push(id);
    },
  );
  expect(seen).toEqual([f.schedule.id]);
  expect(result.execution?.id).toBe(f.execution.id);
  expect(result.runs.map((run) => run.taskId)).toEqual([f.execution.taskId]);
  await expect(
    scheduledExecutionResult(f.clients, f.projection, "foreign", f.request, async () => {}),
  ).rejects.toMatchObject({ code: Code.NotFound });
  await expect(
    scheduledExecutionResult(f.clients, f.projection, "agentos", f.request, async () => {
      throw new ConnectError("Not authorized", Code.PermissionDenied);
    }),
  ).rejects.toMatchObject({ code: Code.PermissionDenied });
});

it("fails closed for an unknown cursor or missing original native task", async () => {
  const f = await setup();
  if (!f.request.page) throw new Error("Missing page");
  f.request.page.pageToken = randomUUID();
  await expect(
    scheduledExecutionResult(f.clients, f.projection, "agentos", f.request, async () => {}),
  ).rejects.toMatchObject({ code: Code.InvalidArgument });
  f.request.page.pageToken = "";
  const native = f.fake.schedules.executions.get(f.execution.id);
  if (!native) throw new Error("Missing native execution");
  native.taskId = randomUUID();
  await expect(
    scheduledExecutionResult(f.clients, f.projection, "agentos", f.request, async () => {}),
  ).rejects.toMatchObject({ code: Code.Unavailable });
});
