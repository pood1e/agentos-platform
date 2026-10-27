import { expect, it, onTestFinished } from "vitest";
import { ScheduledRunExecutionState } from "../gen/kagent/api/v1/scheduled_runs_pb.js";
import { automationPresets } from "../server/automation/presets.js";
import { scheduledSourceTools } from "../server/automation/source-tools.js";
import { environment } from "./harness.js";

function protocol(handler: ReturnType<typeof scheduledSourceTools>) {
  return async (method: string, params: object = {}) => {
    const response = await handler.fetch(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      }),
    );
    const body = await response.text();
    return JSON.parse(body.startsWith("event:") ? (body.split("data: ")[1] ?? "{}") : body);
  };
}

it("exposes only read-only result tools and refuses schedules outside the source binding", async () => {
  const env = environment([]);
  onTestFinished(() => env.sync.close());
  const presets = automationPresets("agentos", "tests/fixtures/pack");
  await presets.seed(env.clients);
  const first = presets.scheduledRuns[0];
  if (!first) throw new Error("Missing preset");
  const handler = scheduledSourceTools(env.clients, env.sync, "agentos", presets.scheduledRuns, [
    first.key,
  ]);
  const rpc = protocol(handler);
  const tools = (await rpc("tools/list")).result.tools;
  expect(tools.map((tool: { name: string }) => tool.name)).toEqual([
    "list_scheduled_run_executions",
    "get_scheduled_run_execution_result",
  ]);
  expect(
    tools.every(
      (tool: { annotations: { readOnlyHint: boolean } }) => tool.annotations.readOnlyHint,
    ),
  ).toBe(true);
  const denied = await rpc("tools/call", {
    name: "list_scheduled_run_executions",
    arguments: { presetKey: "foreign" },
  });
  expect(denied.error || denied.result?.isError).toBeTruthy();
  const write = await rpc("tools/call", { name: "run_case", arguments: {} });
  expect(write.error || write.result?.isError).toBeTruthy();
});

import { randomUUID } from "node:crypto";

it("dispatches only explicitly bound presets without creating a session for skipped occurrences", async () => {
  const env = environment([]);
  onTestFinished(() => env.sync.close());
  const presets = automationPresets("agentos", "tests/fixtures/pack");
  await presets.seed(env.clients);
  const [allowed, foreign] = presets.scheduledRuns;
  for (const preset of [allowed, foreign]) {
    const { scheduledRun } = await env.clients.schedules.getScheduledRun({
      scheduledRunId: preset.scheduledRunId,
    });
    if (!scheduledRun?.config) throw new Error("Missing schedule");
    await env.clients.schedules.updateScheduledRun({
      scheduledRunId: scheduledRun.id,
      etag: scheduledRun.etag,
      config: { ...scheduledRun.config, dispatchRequired: true },
    });
  }
  const rpc = protocol(
    scheduledSourceTools(
      env.clients,
      env.sync,
      "agentos",
      presets.scheduledRuns,
      [allowed.key],
      [allowed.key],
    ),
  );
  const firing = async (id: string) => {
    const { execution } = await env.clients.schedules.triggerScheduledRun({
      scheduledRunId: id,
      requestId: randomUUID(),
    });
    if (!execution) throw new Error("Missing execution");
    return execution;
  };
  const dispatch = (executionId: string, skip: boolean) =>
    rpc("tools/call", {
      name: "dispatch_scheduled_run_execution",
      arguments: { executionId, skip, reason: "no pending work" },
    });
  const sessions = env.fake.sessions.size;
  const skipped = await firing(allowed.scheduledRunId);
  expect(skipped.awaitingDispatch).toBe(true);
  expect(env.fake.sessions.size).toBe(sessions);
  expect((await dispatch(skipped.id, true)).result.isError).toBeFalsy();
  expect(
    (await env.clients.schedules.getScheduledRunExecution({ executionId: skipped.id })).execution,
  ).toMatchObject({
    state: ScheduledRunExecutionState.SKIPPED,
    awaitingDispatch: false,
    sessionId: "",
    dispatchReason: "no pending work",
  });
  expect((await dispatch(skipped.id, true)).result.isError).toBeFalsy();
  const conflict = await dispatch(skipped.id, false);
  expect(conflict.error || conflict.result?.isError).toBeTruthy();
  const denied = await dispatch((await firing(foreign.scheduledRunId)).id, false);
  expect(denied.error || denied.result?.isError).toBeTruthy();
  expect(env.fake.sessions.size).toBe(sessions);
  const started = await firing(allowed.scheduledRunId);
  expect((await dispatch(started.id, false)).result.isError).toBeFalsy();
  expect(
    (await env.clients.schedules.getScheduledRunExecution({ executionId: started.id })).execution
      ?.sessionId,
  ).not.toBe("");
  expect((await dispatch(started.id, false)).result.isError).toBeFalsy();
  expect(env.fake.sessions.size).toBe(sessions + 1);
  const history = await rpc("tools/call", {
    name: "list_scheduled_run_executions",
    arguments: { presetKey: allowed.key, activeOnly: true },
  });
  expect(
    history.result.structuredContent.executions.map((item: { id: string }) => item.id),
  ).toEqual([started.id]);
});
