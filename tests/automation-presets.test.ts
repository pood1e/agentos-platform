import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { automationPresets } from "../server/automation/presets.js";
import { fakeKagent } from "./harness.js";

it("updates pack instructions by native etag while retaining the schedule ID, cycle, enabled state and history", async () => {
  const env = fakeKagent([]);
  const [original] = await automationPresets("agentos", "tests/fixtures/pack").seed(env.clients);
  if (!original) throw new Error("Missing preset");
  const { scheduledRun } = await env.clients.schedules.getScheduledRun({
    scheduledRunId: original.scheduledRunId,
  });
  if (!scheduledRun?.config) throw new Error("Missing schedule");
  await env.clients.schedules.updateScheduledRun({
    scheduledRunId: scheduledRun.id,
    etag: scheduledRun.etag,
    config: { ...scheduledRun.config, paused: false, schedule: "*/7 * * * *" },
  });
  const { execution } = await env.clients.schedules.triggerScheduledRun({
    scheduledRunId: scheduledRun.id,
    requestId: "before-upgrade",
  });
  const directory = await mkdtemp(join(tmpdir(), "automation-presets-"));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const { readFile } = await import("node:fs/promises");
  const pack = JSON.parse(await readFile("tests/fixtures/pack/automation.json", "utf8"));
  pack.scheduledRunPrompts = {
    [original.key]: "Read native incident evidence and validate the report.",
  };
  pack.externallyDispatchedPresets = [original.key];
  await writeFile(join(directory, "automation.json"), JSON.stringify(pack));
  const updated = automationPresets("agentos", directory);
  await updated.seed(env.clients);
  expect((await updated.seed(env.clients))[0]?.scheduledRunId).toBe(scheduledRun.id);
  const { scheduledRun: current } = await env.clients.schedules.getScheduledRun({
    scheduledRunId: scheduledRun.id,
  });
  expect(current?.config).toMatchObject({
    paused: false,
    schedule: "*/7 * * * *",
    prompt: pack.scheduledRunPrompts[original.key],
    dispatchRequired: true,
  });
  expect(
    (await env.clients.schedules.listScheduledRunExecutions({ scheduledRunId: scheduledRun.id }))
      .executions[0]?.id,
  ).toBe(execution?.id);
});
