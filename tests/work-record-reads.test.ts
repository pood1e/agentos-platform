import { clone, create } from "@bufbuild/protobuf";
import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError } from "@connectrpc/connect";
import { afterEach, expect, it, vi } from "vitest";
import {
  ArtifactSchema,
  ListTasksResponseSchema,
  TaskSchema,
  TaskState,
  TaskStatusSchema,
} from "../gen/a2a_pb.js";
import { ListEngineerRunsRequestSchema } from "../gen/agentos/console/v1/console_service_pb.js";
import { ActivityState } from "../gen/agentos/execution/v1/state_pb.js";
import { taskRecords } from "../server/read-model/records.js";
import { fixtureExecution, fixtureIds } from "./fixtures/kagent.js";
import { consoleClient, environment, operator } from "./harness.js";

afterEach(() => vi.restoreAllMocks());

async function history() {
  const env = await environment();
  const original = env.fake.task(fixtureIds.inspection);
  const session = env.fake.sessions.get(original.contextId);
  if (!session) throw new Error("Missing inspection session");
  env.fake.tasks.clear();
  env.fake.executions.clear();
  const tasks = Array.from({ length: 24 }, (_, index) => {
    const task = clone(TaskSchema, original);
    task.id = `70000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
    task.status = create(TaskStatusSchema, {
      ...task.status,
      state: TaskState.COMPLETED,
      timestamp: timestampFromMs(Date.UTC(2027, 0, 1) - index * 1000),
    });
    env.fake.tasks.set(task.id, task);
    env.fake.executions.set(task.id, fixtureExecution(task));
    return task;
  });
  return { ...env, tasks, client: consoleClient(env) };
}

it("filters native inventory by engineer and hydrates only the selected historical page", async () => {
  const env = await history();
  const sessions = vi.spyOn(env.clients.sessions, "listSessions");
  const list = vi.spyOn(env.clients.a2a, "listTasks");
  try {
    const first = await env.client.listEngineerRuns({
      engineer: "agentos/inspection",
      pageSize: 3,
    });
    expect(first.runs.map((run) => run.taskId)).toEqual(
      env.tasks.slice(0, 3).map((task) => task.id),
    );
    expect(env.fake.fetched).toHaveLength(3);
    expect(first.runs.every((run) => run.output && run.calls.length)).toBe(true);
    expect(sessions.mock.calls.every(([input]) => input.agent?.name === "inspection")).toBe(true);
    expect(
      list.mock.calls.every(
        ([input]) =>
          input.tenant === "agentos/inspection" &&
          input.historyLength === 0 &&
          input.includeArtifacts === false,
      ),
    ).toBe(true);
    const next = await env.client.listEngineerRuns({
      engineer: "agentos/inspection",
      pageSize: 3,
      pageToken: first.nextPageToken,
    });
    expect(next.runs.map((run) => run.taskId)).toEqual(
      env.tasks.slice(3, 6).map((task) => task.id),
    );
    expect(env.fake.fetched).toHaveLength(6);
    await env.client.listEngineerRuns({ engineer: "agentos/inspection", pageSize: 3 });
    expect(env.fake.fetched).toHaveLength(6);
    expect(list.mock.calls.length).toBeGreaterThan(2);
  } finally {
    await env.close();
  }
});

it("rechecks native reads after a cached page and isolates terminal projections by subject", async () => {
  const env = await history();
  try {
    await env.client.listEngineerRuns({ engineer: "agentos/inspection", pageSize: 2 });
    await env.projection.engineerRuns(
      { subject: "another-reader", administrator: false },
      create(ListEngineerRunsRequestSchema, { engineer: "agentos/inspection", pageSize: 2 }),
    );
    expect(env.fake.fetched).toHaveLength(4);
    const reads = vi.spyOn(env.clients.a2a, "listTasks");
    reads.mockRejectedValue(new ConnectError("read revoked", Code.PermissionDenied));
    await expect(
      env.client.listEngineerRuns({ engineer: "agentos/inspection", pageSize: 2 }),
    ).rejects.toMatchObject({ code: Code.PermissionDenied });
    expect(env.fake.fetched).toHaveLength(4);
    reads.mockRestore();
    vi.spyOn(env.clients.sessions, "listSessions").mockRejectedValue(
      new ConnectError("inventory revoked", Code.PermissionDenied),
    );
    await expect(
      env.client.listEngineerRuns({ engineer: "agentos/inspection", pageSize: 2 }),
    ).rejects.toMatchObject({ code: Code.PermissionDenied });
  } finally {
    await env.close();
  }
});

it("loads only the selected active page when history has no state filter", async () => {
  const env = await history();
  for (const task of env.tasks) if (task.status) task.status.state = TaskState.WORKING;
  try {
    const result = await env.client.listEngineerRuns({
      engineer: "agentos/inspection",
      pageSize: 2,
    });
    expect(result.runs).toHaveLength(2);
    expect(result.runs.every((run) => run.state === ActivityState.WORKING)).toBe(true);
    expect(env.fake.fetched).toHaveLength(2);
  } finally {
    await env.close();
  }
});

it("reuses terminal projections across native metadata ordering while invalidating content changes", async () => {
  const env = await history();
  const task = env.tasks[0];
  if (!task) throw new Error("Missing task");
  task.metadata = { first: 1, second: { left: true, right: false } };
  try {
    await env.client.listEngineerRuns({ engineer: "agentos/inspection", pageSize: 1 });
    expect(env.fake.fetched).toHaveLength(1);
    task.metadata = { second: { right: false, left: true }, first: 1 };
    await env.client.listEngineerRuns({ engineer: "agentos/inspection", pageSize: 1 });
    expect(env.fake.fetched).toHaveLength(1);
    task.metadata.first = 2;
    await env.client.listEngineerRuns({ engineer: "agentos/inspection", pageSize: 1 });
    expect(env.fake.fetched).toHaveLength(2);
  } finally {
    await env.close();
  }
});

it("bounds lightweight catalog concurrency independently of full-task hydration", async () => {
  const env = await environment();
  let active = 0;
  let peak = 0;
  vi.spyOn(env.clients.a2a, "listTasks").mockImplementation(async () => {
    peak = Math.max(peak, ++active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--;
    return create(ListTasksResponseSchema);
  });
  try {
    await taskRecords(env.clients).list(
      Array.from({ length: 40 }, (_, index) => ({
        id: String(index),
        agentId: "agentos/inspection",
        name: "",
      })),
    );
    expect(peak).toBe(16);
    expect(active).toBe(0);
  } finally {
    await env.close();
  }
});

it("refreshes active output and terminal versions without caching upstream failures", async () => {
  const env = await history();
  const task = env.tasks[0];
  if (!task?.status) throw new Error("Missing task status");
  task.status.state = TaskState.WORKING;
  try {
    const request = {
      engineer: "agentos/inspection",
      pageSize: 1,
      states: [ActivityState.WORKING],
    };
    await env.client.listEngineerRuns(request);
    const fetched = env.fake.fetched.length;
    task.artifacts.push(
      create(ArtifactSchema, {
        artifactId: "fresh-progress",
        parts: [{ content: { case: "text", value: "Fresh progress" } }],
        metadata: { "kagent.dev/a2a/timeline-position": "2027-01-02T00:00:00Z" },
      }),
    );
    const active = await env.client.listEngineerRuns(request);
    expect(active.runs[0]?.progress).toContain("Fresh progress");
    expect(env.fake.fetched.length).toBeGreaterThan(fetched);
    task.status.state = TaskState.COMPLETED;
    const get = vi.spyOn(env.clients.a2a, "getTask");
    get.mockRejectedValueOnce(new ConnectError("temporarily offline", Code.Unavailable));
    await expect(
      env.client.listEngineerRuns({ engineer: "agentos/inspection", pageSize: 1 }),
    ).rejects.toMatchObject({ code: Code.Unavailable });
    const completed = await env.client.listEngineerRuns({
      engineer: "agentos/inspection",
      pageSize: 1,
    });
    expect(completed.runs[0]?.output).toContain("Fresh progress");
    const before = env.fake.fetched.length;
    await env.client.listEngineerRuns({ engineer: "agentos/inspection", pageSize: 1 });
    expect(env.fake.fetched).toHaveLength(before);
    task.status.timestamp = timestampFromMs(Date.UTC(2027, 0, 3));
    await env.client.listEngineerRuns({ engineer: "agentos/inspection", pageSize: 1 });
    expect(env.fake.fetched).toHaveLength(before + 1);
  } finally {
    await env.close();
  }
});

it("inherits background lineage across agents without fetching ancestor task content", async () => {
  const env = await environment();
  const root = env.fake.executions.get(fixtureIds.dispatchRoot);
  if (!root) throw new Error("Missing dispatch execution");
  root.background = true;
  try {
    const result = await consoleClient(env).listEngineerRuns({
      engineer: "agentos/inspection",
      pageSize: 100,
    });
    expect(result.runs.find((run) => run.taskId === fixtureIds.inspection)?.background).toBe(true);
    expect(env.fake.fetched).not.toContain(fixtureIds.dispatchRoot);
    const callCount = env.fake.fetched.length;
    const outside = await env.projection.engineerRuns(
      { subject: operator.subject, administrator: true },
      create(ListEngineerRunsRequestSchema, {
        engineer: "other-workspace/inspection",
        pageSize: 100,
      }),
    );
    expect(outside.runs).toEqual([]);
    expect(env.fake.fetched).toHaveLength(callCount);
  } finally {
    await env.close();
  }
});

it("reuses unchanged terminal projections after an idle interval and rechecks visibility", async () => {
  const env = await history();
  const clock = vi.spyOn(performance, "now").mockReturnValue(1000);
  try {
    const request = { engineer: "agentos/inspection", pageSize: 2 };
    await env.client.listEngineerRuns(request);
    expect(env.fake.fetched).toHaveLength(2);
    clock.mockReturnValue(121_000);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await env.client.listEngineerRuns(request);
    expect(env.fake.fetched).toHaveLength(2);
    vi.spyOn(env.clients.a2a, "listTasks").mockRejectedValue(
      new ConnectError("read revoked", Code.PermissionDenied),
    );
    await expect(env.client.listEngineerRuns(request)).rejects.toMatchObject({
      code: Code.PermissionDenied,
    });
  } finally {
    clock.mockRestore();
    await env.close();
  }
});

it("bounds cold full-task hydration independently of catalog concurrency", async () => {
  const env = await history();
  const getTask = env.clients.a2a.getTask;
  let active = 0;
  let peak = 0;
  vi.spyOn(env.clients.a2a, "getTask").mockImplementation(async (request, options) => {
    peak = Math.max(peak, ++active);
    try {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return await getTask(request, options);
    } finally {
      active--;
    }
  });
  try {
    const result = await env.client.listEngineerRuns({
      engineer: "agentos/inspection",
      pageSize: 20,
    });
    expect(result.runs).toHaveLength(20);
    expect(peak).toBe(8);
    expect(active).toBe(0);
  } finally {
    await env.close();
  }
});
