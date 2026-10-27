import { randomUUID } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { Code, createClient, createRouterTransport } from "@connectrpc/connect";
import { createValidateInterceptor } from "@connectrpc/validate";
import { afterEach, expect, it } from "vitest";
import { Capability } from "../gen/agentos/authorization/v1/permission_pb.js";
import { CaseTriggerSchema } from "../gen/agentos/automation/v1/automation_pb.js";
import { AutomationService } from "../gen/agentos/automation/v1/service_pb.js";
import { ExecutionIdentitySchema } from "../gen/agentos/execution/v1/identity_pb.js";
import { ScheduledRunSchema } from "../gen/kagent/api/v1/scheduled_runs_pb.js";
import { automationPresets } from "../server/automation/presets.js";
import { automationService } from "../server/automation/service.js";
import { workspaceContext } from "../server/platform/access.js";
import { allCapabilities } from "../shared/permissions.js";
import { environment } from "./harness.js";

const close: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of close.splice(0)) await stop();
});
async function setup() {
  const env = await environment([]);
  close.push(() => env.close());
  const principal = create(ExecutionIdentitySchema, {
    subject: "user:manager",
    write: false,
    capabilities: [Capability.TASKS_MANAGE],
  });
  const presets = automationPresets("agentos", "tests/fixtures/pack");
  await presets.seed(env.clients);
  const service = automationService(
    env.clients,
    "agentos",
    {
      ...presets,
      eventTriggers: [
        create(CaseTriggerSchema, {
          eventNamespace: "ops",
          source: { typePrefix: "alert.lifecycle." },
          agent: { namespace: "agentos", name: "inspection" },
        }),
      ],
    },
    ["test-environment"],
    false,
    env.projection,
  );
  const client = createClient(
    AutomationService,
    createRouterTransport((router) => router.service(AutomationService, service), {
      router: {
        interceptors: [
          workspaceContext("agentos", "assistant", async () => principal),
          createValidateInterceptor(),
        ],
      },
    }),
  );
  return { ...env, principal, client, presets };
}

it("allows every platform administrator to inspect shared system tasks and gates every mutation", async () => {
  const { client, principal } = await setup();
  const schedule = (await client.listScheduledRuns({})).scheduledRuns[0];
  if (!schedule?.config) throw new Error("Missing preset");
  for (const capability of allCapabilities) {
    principal.capabilities = [capability];
    expect((await client.listScheduledRuns({})).scheduledRuns).toHaveLength(2);
    expect((await client.getScheduledRun({ scheduledRunId: schedule.id })).scheduledRun?.id).toBe(
      schedule.id,
    );
    expect(
      (await client.listScheduledRunExecutions({ scheduledRunId: schedule.id })).executions,
    ).toEqual([]);
    expect((await client.listEventTriggers({})).eventTriggers).toHaveLength(1);
    expect((await client.listScheduledRunPresets({})).presets).toHaveLength(2);
  }
  principal.capabilities = [Capability.AGENTS_MANAGE];
  principal.write = true;
  expect((await client.getScheduledRun({ scheduledRunId: schedule.id })).scheduledRun?.id).toBe(
    schedule.id,
  );
  expect(
    (await client.listScheduledRunExecutions({ scheduledRunId: schedule.id })).executions,
  ).toEqual([]);
  expect((await client.listEventTriggers({})).eventTriggers[0]).toMatchObject({
    environment: "test-environment",
    ingressEnabled: false,
    trigger: { eventNamespace: "ops" },
  });
  for (const mutate of [
    () =>
      client.createScheduledRun({
        requestId: randomUUID(),
        agent: schedule.agent,
        config: schedule.config,
      }),
    () =>
      client.updateScheduledRun({
        scheduledRunId: schedule.id,
        etag: schedule.etag,
        config: schedule.config,
      }),
    () => client.deleteScheduledRun({ scheduledRunId: schedule.id }),
    () => client.triggerScheduledRun({ scheduledRunId: schedule.id, requestId: randomUUID() }),
  ])
    await expect(mutate()).rejects.toMatchObject({ code: Code.PermissionDenied });
  principal.write = false;
  principal.capabilities = [Capability.TASKS_MANAGE];
  const { scheduledRun } = await client.updateScheduledRun({
    scheduledRunId: schedule.id,
    etag: schedule.etag,
    config: { ...schedule.config, paused: false },
  });
  expect(scheduledRun?.config?.paused).toBe(false);
});

it("denies ordinary users all system-task definitions, events and execution history even with target write access", async () => {
  const { client, principal } = await setup();
  const schedule = (await client.listScheduledRuns({})).scheduledRuns[0];
  const { execution } = await client.triggerScheduledRun({
    scheduledRunId: schedule.id,
    requestId: randomUUID(),
  });
  principal.capabilities = [];
  principal.write = true;
  for (const read of [
    () => client.listScheduledRuns({}),
    () => client.listScheduledRunPresets({}),
    () => client.getScheduledRun({ scheduledRunId: schedule.id }),
    () => client.listScheduledRunExecutions({ scheduledRunId: schedule.id }),
    () => client.getScheduledRunExecution({ executionId: execution?.id }),
    () => client.getScheduledRunExecutionResult({ executionId: execution?.id }),
    () => client.listEventTriggers({}),
  ])
    await expect(read()).rejects.toMatchObject({ code: Code.PermissionDenied });
});

it("keeps scheduling mutations, stale edits, idempotent triggers and retained history in the native service", async () => {
  const { client } = await setup();
  const request = {
    requestId: randomUUID(),
    agent: { namespace: "agentos", name: "inspection" },
    config: {
      name: "Operational review",
      schedule: "0 9 * * *",
      timeZone: "UTC",
      prompt: "Read current health",
      paused: true,
    },
  };
  const schedule = (await client.createScheduledRun(request)).scheduledRun;
  if (!schedule?.config) throw new Error("Missing schedule");
  expect((await client.createScheduledRun(request)).scheduledRun?.id).toBe(schedule.id);
  await client.updateScheduledRun({
    scheduledRunId: schedule.id,
    etag: schedule.etag,
    config: { ...schedule.config, name: "Updated review" },
  });
  await expect(
    client.updateScheduledRun({
      scheduledRunId: schedule.id,
      etag: schedule.etag,
      config: schedule.config,
    }),
  ).rejects.toMatchObject({ code: Code.Aborted });
  const firing = { scheduledRunId: schedule.id, requestId: randomUUID() };
  const execution = (await client.triggerScheduledRun(firing)).execution;
  expect((await client.triggerScheduledRun(firing)).execution?.id).toBe(execution?.id);
  expect(
    (await client.listScheduledRunExecutions({ scheduledRunId: schedule.id })).executions,
  ).toHaveLength(1);
  await client.deleteScheduledRun({ scheduledRunId: schedule.id });
  expect((await client.listScheduledRuns({})).scheduledRuns.map((item) => item.id)).not.toContain(
    schedule.id,
  );
  expect(
    (await client.listScheduledRunExecutions({ scheduledRunId: schedule.id })).executions[0]?.id,
  ).toBe(execution?.id);
  expect(
    (await client.getScheduledRunExecution({ executionId: execution?.id })).execution?.sessionId,
  ).toBeTruthy();
});

it("filters foreign-workspace pages and denies guessed schedule and execution IDs", async () => {
  const { fake, client } = await setup();
  const foreign = create(ScheduledRunSchema, {
    id: randomUUID(),
    creator: "agentos",
    etag: randomUUID(),
    agent: { namespace: "foreign", name: "inspection" },
    config: { schedule: "0 9 * * *", prompt: "Private", paused: true },
  });
  fake.schedules.schedules.set(foreign.id, foreign);
  const execution = await fake.schedules.service().triggerScheduledRun?.(
    {
      $typeName: "kagent.api.v1.TriggerScheduledRunRequest",
      scheduledRunId: foreign.id,
      requestId: randomUUID(),
    },
    undefined as never,
  );
  expect(
    (await client.listScheduledRuns({ page: { limit: 1 } })).scheduledRuns[0]?.agent?.namespace,
  ).toBe("agentos");
  await expect(client.getScheduledRun({ scheduledRunId: foreign.id })).rejects.toMatchObject({
    code: Code.NotFound,
  });
  await expect(
    client.createScheduledRun({
      requestId: randomUUID(),
      agent: foreign.agent,
      config: foreign.config,
    }),
  ).rejects.toMatchObject({ code: Code.NotFound });
  await expect(
    client.listScheduledRunExecutions({ scheduledRunId: foreign.id }),
  ).rejects.toMatchObject({ code: Code.NotFound });
  await expect(
    client.getScheduledRunExecution({ executionId: execution?.execution?.id }),
  ).rejects.toMatchObject({ code: Code.NotFound });
});

it("retains stable preset references and operator edits across startup, and protects presets from deletion", async () => {
  const { clients, client, presets } = await setup();
  const before = (await client.listScheduledRunPresets({})).presets;
  expect(before.map((preset) => preset.key)).toEqual(["inspection-v1", "report-v1"]);
  const id = before[0].scheduledRunId;
  const schedule = (await client.getScheduledRun({ scheduledRunId: id })).scheduledRun;
  if (!schedule?.config) throw new Error("Missing preset");
  await client.updateScheduledRun({
    scheduledRunId: schedule.id,
    etag: schedule.etag,
    config: {
      ...schedule.config,
      name: "Operator's configuration",
      schedule: "*/15 * * * *",
      paused: false,
    },
  });
  await expect(client.deleteScheduledRun({ scheduledRunId: id })).rejects.toMatchObject({
    code: Code.FailedPrecondition,
  });
  const restarted = automationPresets("agentos", "tests/fixtures/pack");
  await restarted.seed(clients);
  expect(restarted.scheduledRuns).toEqual(before);
  await presets.seed(clients);
  expect((await client.listScheduledRunPresets({})).presets).toEqual(before);
  expect((await client.getScheduledRun({ scheduledRunId: id })).scheduledRun?.config).toMatchObject(
    {
      name: "Operator's configuration",
      schedule: "*/15 * * * *",
      paused: false,
    },
  );
});
