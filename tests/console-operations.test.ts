import { create } from "@bufbuild/protobuf";
import { timestampMs } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError } from "@connectrpc/connect";
import { expect, it, vi } from "vitest";
import { MessageSchema, Role, TaskState } from "../gen/a2a_pb.js";
import { ActivityState } from "../gen/agentos/console/v1/state_pb.js";
import { cancelTree } from "../server/read-model/cancel.js";
import { taskTree } from "../server/read-model/tree.js";
import { taskRun } from "../server/read-model/views/run.js";
import { listTasks, taskDetail } from "../server/read-model/views/task.js";
import { pendingApprovalTasks } from "./fake-kagent/scenario.js";
import { fixtureIds as ids } from "./fixtures/kagent.js";
import { environment } from "./harness.js";

const page = { query: "", pageSize: 1, pageToken: "" };

it("filters the operation state and participating member together, including paused descendants", async () => {
  const { sync, index } = environment(pendingApprovalTasks());
  try {
    await sync.refresh();
    const pending = listTasks(index, { ...page, states: [ActivityState.AWAITING_APPROVAL] });
    expect(pending.tasks.map((task) => task.id)).toEqual([ids.approvalRoot]);
    expect(pending.totalSize).toBe(1);
    expect(
      listTasks(index, {
        ...page,
        states: [ActivityState.AWAITING_APPROVAL],
        engineer: "agentos/remediation",
      }).tasks,
    ).toEqual(pending.tasks);
    expect(
      listTasks(index, {
        ...page,
        states: [ActivityState.AWAITING_APPROVAL],
        engineer: "agentos/inspection",
      }).totalSize,
    ).toBe(0);
    expect(
      listTasks(index, {
        ...page,
        states: [ActivityState.SUCCEEDED, ActivityState.AWAITING_APPROVAL],
      }).totalSize,
    ).toBeGreaterThan(1);
  } finally {
    sync.close();
  }
});

it("binds cursors to normalized states and members", async () => {
  const { sync, index } = environment(pendingApprovalTasks());
  try {
    await sync.refresh();
    const states = [ActivityState.SUCCEEDED, ActivityState.AWAITING_APPROVAL];
    const first = listTasks(index, { ...page, states });
    expect(first.nextPageToken).not.toBe("");
    const request = { ...page, pageToken: first.nextPageToken, states };
    expect(listTasks(index, { ...request, states: [...states].reverse() }).tasks).toEqual(
      listTasks(index, request).tasks,
    );
    expect(() => listTasks(index, { ...request, states: [ActivityState.SUCCEEDED] })).toThrow(
      "pagination.invalidPage",
    );
    expect(() => listTasks(index, { ...request, engineer: "agentos/remediation" })).toThrow(
      "pagination.invalidPage",
    );
    expect(() => listTasks(index, { ...request, states: [] })).toThrow("pagination.invalidPage");
  } finally {
    sync.close();
  }
});

async function runningTree() {
  const env = environment();
  for (const id of [ids.dispatchRoot, ids.inspection, ids.background])
    env.fake.update(env.fake.task(id), TaskState.WORKING);
  await env.sync.refresh();
  const tree = taskTree(env.index, ids.dispatchRoot);
  if (!tree) throw new Error("missing operation tree");
  return { ...env, tree };
}

it("cancels all unfinished foreground tasks, retains background tasks and is repeatable", async () => {
  const { clients, sync, index, tree, fake } = await runningTree();
  const cancel = vi.spyOn(clients.a2a, "cancelTask");
  try {
    await cancelTree(clients, sync, tree);
    expect(cancel.mock.calls.map(([request]) => request.id)).toEqual(
      expect.arrayContaining([ids.dispatchRoot, ids.inspection]),
    );
    expect(cancel.mock.calls.map(([request]) => request.id)).not.toContain(ids.background);
    expect(index.entry(ids.inspection)?.state).toBe(TaskState.CANCELED);
    expect(fake.task(ids.background).status?.state).toBe(TaskState.WORKING);
    expect(taskDetail(index, ids.dispatchRoot)?.summary?.state).toBe(ActivityState.CANCELED);
    const again = taskTree(index, ids.dispatchRoot);
    if (!again) throw new Error("missing operation");
    const count = cancel.mock.calls.length;
    await cancelTree(clients, sync, again);
    expect(cancel).toHaveBeenCalledTimes(count);
  } finally {
    sync.close();
  }
});

it("attempts every cancellation and keeps native successes when one task fails", async () => {
  const { clients, sync, index, tree } = await runningTree();
  const native = clients.a2a.cancelTask;
  const cancel = vi
    .spyOn(clients.a2a, "cancelTask")
    .mockImplementation(async (request, options) => {
      if (request.id === ids.dispatchRoot) throw new Error("native cancellation failed");
      return native(request, options);
    });
  try {
    await expect(cancelTree(clients, sync, tree)).rejects.toThrow("native cancellation failed");
    expect(cancel).toHaveBeenCalledWith(
      expect.objectContaining({ id: ids.inspection }),
      expect.anything(),
    );
    expect(index.entry(ids.inspection)?.state).toBe(TaskState.CANCELED);
    expect(index.entry(ids.dispatchRoot)?.state).toBe(TaskState.WORKING);
  } finally {
    sync.close();
  }
});

it("projects native run starts in summaries and full execution details", async () => {
  const { sync, index } = environment();
  try {
    await sync.refresh();
    const detail = taskDetail(index, ids.dispatchRoot);
    for (const run of detail?.runs ?? []) {
      expect(run.startedAt && timestampMs(run.startedAt)).toBe(index.entry(run.taskId)?.createdAt);
      const full = await taskRun(sync, run.taskId);
      expect(full?.startedAt).toEqual(run.startedAt);
    }
  } finally {
    sync.close();
  }
});

it("accepts a native task that finishes between reading the tree and canceling it", async () => {
  const { clients, sync, index, tree, fake } = await runningTree();
  const native = clients.a2a.cancelTask;
  vi.spyOn(clients.a2a, "cancelTask").mockImplementation(async (request, options) => {
    if (request.id !== ids.inspection) return native(request, options);
    fake.update(fake.task(ids.inspection), TaskState.COMPLETED);
    throw new ConnectError("task is already complete", Code.FailedPrecondition);
  });
  try {
    await cancelTree(clients, sync, tree);
    expect(index.entry(ids.inspection)?.state).toBe(TaskState.COMPLETED);
    expect(index.entry(ids.dispatchRoot)?.state).toBe(TaskState.CANCELED);
  } finally {
    sync.close();
  }
});

it("keeps a canceled fake execution from completing on its pending timer", async () => {
  vi.useFakeTimers();
  const { fake, clients, sync } = environment();
  try {
    const session = fake.createSession(
      { namespace: "agentos", name: "assistant" },
      "cancel-race",
      "Cancel race",
    );
    const task = fake.accept(
      create(MessageSchema, {
        contextId: session.id,
        messageId: "cancel-race",
        role: Role.USER,
        parts: [{ content: { case: "text", value: "Inspect" } }],
      }),
    );
    await clients.a2a.cancelTask({ tenant: "agentos/assistant", id: task.id });
    await vi.advanceTimersByTimeAsync(250);
    expect(fake.task(task.id).status?.state).toBe(TaskState.CANCELED);
    expect(task.artifacts).toHaveLength(0);
  } finally {
    sync.close();
    vi.useRealTimers();
  }
});
