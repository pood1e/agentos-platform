import { clone } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { afterEach, expect, it, vi } from "vitest";
import { TaskSchema, TaskState } from "../gen/a2a_pb.js";
import { ActivityState } from "../gen/agentos/execution/v1/state_pb.js";
import { fixtureExecution, fixtureIds } from "./fixtures/kagent.js";
import { consoleClient, environment } from "./harness.js";

afterEach(() => vi.restoreAllMocks());

it("returns the page's native topology without archived transcript hydration", async () => {
  const env = await environment();
  const original = env.fake.task(fixtureIds.inspection);
  env.fake.tasks.clear();
  env.fake.executions.clear();
  for (let index = 0; index < 40; index++) {
    const task = clone(TaskSchema, original);
    task.id = `70000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
    if (task.status) task.status.state = index === 0 ? TaskState.WORKING : TaskState.COMPLETED;
    env.fake.tasks.set(task.id, task);
    env.fake.executions.set(task.id, fixtureExecution(task));
  }
  const lineage = vi.spyOn(env.clients.execution, "getTaskExecution");
  try {
    const client = consoleClient(env);
    const result = await client.listTasks({
      includeExecutionGraph: true,
      states: [ActivityState.WORKING],
      pageSize: 100,
    });
    expect(result.tasks).toHaveLength(1);
    expect(result.executionGraph?.runs).toHaveLength(1);
    expect(result.executionGraph?.runs[0]?.execution?.task?.taskId).toBe(result.tasks[0]?.id);
    expect(
      result.executionGraph?.runs.every((run) => !run.output && !run.progress && !run.calls.length),
    ).toBe(true);
    expect(env.fake.fetched).toHaveLength(1);
    const reads = lineage.mock.calls.length;
    await client.listTasks({
      includeExecutionGraph: true,
      states: [ActivityState.WORKING],
      pageSize: 100,
    });
    expect(env.fake.fetched).toHaveLength(2);
    expect(lineage).toHaveBeenCalledTimes(reads);
    vi.spyOn(env.clients.sessions, "listSessions").mockRejectedValue(
      new ConnectError("revoked", Code.PermissionDenied),
    );
    await expect(client.listTasks({ includeExecutionGraph: true })).rejects.toMatchObject({
      code: Code.PermissionDenied,
    });
  } finally {
    await env.close();
  }
});

it("scopes execution graph metadata to the returned operation page", async () => {
  const env = await environment();
  try {
    const client = consoleClient(env);
    const result = await client.listTasks({ includeExecutionGraph: true, pageSize: 1 });
    const ids = new Set(result.executionGraph?.runs.map((run) => run.taskId));
    expect(result.tasks).toHaveLength(1);
    expect(ids.has(result.tasks[0]?.id ?? "")).toBe(true);
    for (const run of result.executionGraph?.runs ?? []) {
      expect(run.execution).toBeDefined();
      expect(run.calls).toEqual([]);
      expect(run.prompt).toBe("");
    }
    const regular = await client.listTasks({ pageSize: 1 });
    expect(regular.executionGraph).toBeUndefined();
  } finally {
    await env.close();
  }
});
