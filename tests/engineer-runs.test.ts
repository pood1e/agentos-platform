import { clone, create } from "@bufbuild/protobuf";
import { Code } from "@connectrpc/connect";
import { expect, it, vi } from "vitest";
import { ArtifactSchema, TaskSchema, TaskState } from "../gen/a2a_pb.js";
import { ActivityState } from "../gen/agentos/execution/v1/state_pb.js";
import { TaskCatalogView } from "../gen/kagent/api/v1/task_catalog_pb.js";
import { engineer } from "../server/read-model/views/engineers.js";
import { fixtureState, fixtureTasks, fixtureIds as ids } from "./fixtures/kagent.js";
import { toolPart } from "./fixtures/ordered-chat.js";
import { consoleClient, environment } from "./harness.js";

it("reports actual running work even alongside a paused run", () => {
  const index = fixtureState();
  const entry = index.entry(ids.background);
  if (!entry) throw new Error("Missing background fixture");
  const waiting = { ...entry, state: TaskState.INPUT_REQUIRED, interactions: [] };
  const working = { ...entry, id: "working-run", state: TaskState.WORKING, interactions: [] };
  expect(engineer(index.graph(), entry.agentId, [waiting, working]).state).toBe(
    ActivityState.WORKING,
  );
  expect(engineer(index.graph(), entry.agentId, [waiting]).state).toBe(
    ActivityState.AWAITING_INPUT,
  );
  expect(
    engineer(index.graph(), entry.agentId, [
      { ...entry, state: TaskState.UNSPECIFIED, interactions: [] },
    ]).state,
  ).toBe(ActivityState.UNOBSERVED);
});

it("exposes an authenticated read-only engineer run API", async () => {
  const env = await environment();
  try {
    const client = consoleClient(env);
    const result = await client.listEngineerRuns({ engineer: "agentos/inspection", pageSize: 20 });
    expect(result.runs.length).toBeGreaterThan(0);
    expect(result.runs.every((run) => run.agentId === "agentos/inspection")).toBe(true);
    await expect(client.listEngineerRuns({ engineer: "" })).rejects.toMatchObject({
      code: Code.InvalidArgument,
    });
  } finally {
    await env.close();
  }
});

it("reads compact terminal records while preserving active details", async () => {
  const env = await environment();
  try {
    const client = consoleClient(env);
    const catalog = vi.spyOn(env.clients.catalog, "listTaskRecords");
    const summary = await client.listEngineerRuns({ engineer: "agentos/inspection", pageSize: 100 });
    expect(catalog.mock.calls.at(-1)?.[0]).toMatchObject({
      view: TaskCatalogView.ACTIVE_DETAILS,
      page: { limit: 100 },
    });
    expect(summary.runs.length).toBeGreaterThan(0);
    expect(
      summary.runs.filter((run) => run.state === ActivityState.SUCCEEDED).every(
        (run) => !run.calls.length && !run.output,
      ),
    ).toBe(true);
  } finally {
    await env.close();
  }
});

it("returns changing native run progress and tool activity through the console API", async () => {
  const tasks = fixtureTasks();
  const original = tasks.find((task) => task.id === ids.background);
  const engineerId = fixtureState().entry(ids.background)?.agentId;
  if (!original || !engineerId) throw new Error("Missing background fixture");
  const work = clone(TaskSchema, original);
  if (!work.status) throw new Error("Missing task status");
  work.status.state = TaskState.WORKING;
  work.artifacts = [
    create(ArtifactSchema, {
      artifactId: "live-progress",
      parts: [
        { content: { case: "text", value: "Checking current metrics" } },
        toolPart("function_call", "inspect-metrics"),
      ],
    }),
  ];
  const env = await environment(tasks.map((task) => (task.id === work.id ? work : task)));
  try {
    const client = consoleClient(env);
    const active = await client.listEngineerRuns({
      engineer: engineerId,
      states: [ActivityState.WORKING],
    });
    const run = active.runs.find((item) => item.taskId === work.id);
    expect(run).toMatchObject({
      state: ActivityState.WORKING,
      background: true,
      progress: "Checking current metrics",
    });
    expect(run?.calls).toContainEqual(
      expect.objectContaining({
        id: "inspect-metrics",
        name: "k8s_get_resources",
        state: ActivityState.WORKING,
        intent: "Checking current metrics",
      }),
    );
    expect(run?.calls[0]?.args).toBeUndefined();
    expect(run?.calls[0]?.output).toBeUndefined();

    work.artifacts.push(
      create(ArtifactSchema, {
        artifactId: "final-answer",
        parts: [{ content: { case: "text", value: "Metrics are healthy" } }],
      }),
    );
    env.fake.update(work, TaskState.COMPLETED);
    const current = await client.listEngineerRuns({
      engineer: engineerId,
      states: [ActivityState.WORKING],
    });
    expect(current.runs.some((item) => item.taskId === work.id)).toBe(false);
    const history = await client.listEngineerRuns({ engineer: engineerId });
    expect(history.runs.find((item) => item.taskId === work.id)).toMatchObject({
      state: ActivityState.SUCCEEDED,
      progress: "",
      output: "",
      calls: [],
    });
  } finally {
    await env.close();
  }
});
