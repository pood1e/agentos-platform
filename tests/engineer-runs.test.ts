import { clone, create } from "@bufbuild/protobuf";
import { Code } from "@connectrpc/connect";
import { expect, it } from "vitest";
import { ArtifactSchema, TaskSchema, TaskState } from "../gen/a2a_pb.js";
import { ListEngineerRunsRequestSchema } from "../gen/agentos/console/v1/console_service_pb.js";
import { ActivityState } from "../gen/agentos/execution/v1/state_pb.js";
import { engineerRunListings } from "../server/read-model/engineer-runs.js";
import { taskTree } from "../server/read-model/tree.js";
import { engineer } from "../server/read-model/views/engineers.js";
import { taskSummary } from "../server/read-model/views/task.js";
import { fixtureState, fixtureTasks, fixtureIds as ids } from "./fixtures/kagent.js";
import { toolPart } from "./fixtures/ordered-chat.js";
import { consoleClient, environment, operator } from "./harness.js";

function workListing(index: ReturnType<typeof fixtureState>) {
  return engineerRunListings({
    list: async (_viewer, engineerId) =>
      index
        .graph()
        .agentEntries(engineerId)
        .flatMap((entry) => {
          const session = index.graph().session(entry.contextId);
          return session ? [{ summary: entry, session }] : [];
        }),
    read: async (_viewer, records) => records.map((record) => record.summary),
    background: async (entries) => {
      const graph = index.graph();
      return new Map(
        entries.map((entry) => {
          const root = graph.operationRoot(entry.id);
          return [
            entry.id,
            root ? (taskTree(graph, root.id)?.background.has(entry.id) ?? false) : false,
          ];
        }),
      );
    },
  });
}

it("projects the engineer's exact working runs, including background work and current actions", async () => {
  const index = fixtureState();
  const original = index.entry(ids.background);
  if (!original) throw new Error("Missing background fixture");
  const working = {
    ...original,
    state: TaskState.WORKING,
    prompt: "Inspect the network fabric",
    progress: "Checking error rates",
    answer: "partial draft",
    calls: [
      {
        id: "call-1",
        name: "read_metrics",
        intent: "Checking interface errors",
        state: ActivityState.WORKING,
      },
    ],
    interactions: [],
  };
  index.upsert(working);
  const graph = index.graph();
  const tree = taskTree(graph, ids.dispatchRoot);
  if (!tree) throw new Error("Missing operation");
  expect(taskSummary(graph, tree).state).toBe(ActivityState.SUCCEEDED);
  const query = workListing(index);
  const response = await query.engineerRuns(
    { subject: operator.subject, administrator: false },
    create(ListEngineerRunsRequestSchema, {
      engineer: working.agentId,
      pageSize: 20,
      states: [ActivityState.WORKING],
    }),
  );
  expect(response.runs).toContainEqual(
    expect.objectContaining({
      taskId: ids.background,
      agentId: working.agentId,
      state: ActivityState.WORKING,
      background: true,
      prompt: "Inspect the network fabric",
      progress: "Checking error rates",
      output: "",
      calls: [
        expect.objectContaining({
          id: "call-1",
          taskId: ids.background,
          agentId: working.agentId,
          name: "read_metrics",
          intent: "Checking interface errors",
          state: ActivityState.WORKING,
        }),
      ],
    }),
  );
  expect(response.runs.every((run) => run.agentId === working.agentId)).toBe(true);
});

it("binds engineer-run cursors to the owner, engineer and state filters", async () => {
  const index = fixtureState();
  const original = index.entry(ids.background);
  if (!original) throw new Error("Missing background fixture");
  index.upsert({ ...original, state: TaskState.WORKING, interactions: [], statusAt: 200 });
  index.upsert({
    ...original,
    id: "other-run",
    state: TaskState.WORKING,
    interactions: [],
    statusAt: 100,
  });
  const query = workListing(index);
  const viewer = { subject: operator.subject, administrator: false };
  const request = create(ListEngineerRunsRequestSchema, {
    engineer: original.agentId,
    pageSize: 1,
    states: [ActivityState.WORKING],
  });
  const first = await query.engineerRuns(viewer, request);
  expect(first.runs).toHaveLength(1);
  expect(first.nextPageToken).not.toBe("");
  const next = await query.engineerRuns(
    viewer,
    create(ListEngineerRunsRequestSchema, {
      ...request,
      pageToken: first.nextPageToken,
    }),
  );
  expect(next.runs).toHaveLength(1);
  expect(next.runs[0]?.taskId).not.toBe(first.runs[0]?.taskId);
  for (const altered of [
    { engineer: "agentos/other", states: request.states, subject: viewer.subject },
    { engineer: request.engineer, states: [ActivityState.SUCCEEDED], subject: viewer.subject },
    { engineer: request.engineer, states: request.states, subject: "user:other" },
  ]) {
    await expect(
      query.engineerRuns(
        { ...viewer, subject: altered.subject },
        create(ListEngineerRunsRequestSchema, {
          ...request,
          engineer: altered.engineer,
          states: altered.states,
          pageToken: first.nextPageToken,
        }),
      ),
    ).rejects.toMatchObject({ code: Code.InvalidArgument });
  }
});

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
      output: "Metrics are healthy",
    });
  } finally {
    await env.close();
  }
});
