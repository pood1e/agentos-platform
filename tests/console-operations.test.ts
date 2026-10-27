import { clone, create } from "@bufbuild/protobuf";
import { timestampMs } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError } from "@connectrpc/connect";
import { expect, it, vi } from "vitest";
import { MessageSchema, Role, TaskSchema, TaskState } from "../gen/a2a_pb.js";
import { ActivityState } from "../gen/agentos/execution/v1/state_pb.js";
import { cancelTree } from "../server/read-model/cancel.js";
import { taskTree } from "../server/read-model/tree.js";
import { taskRun } from "../server/read-model/views/run.js";
import { runSummary } from "../server/read-model/views/runs.js";
import { taskSummary } from "../server/read-model/views/task.js";
import { pendingApprovalTasks } from "./fake-kagent/scenario.js";
import { fixtureIds as ids } from "./fixtures/kagent.js";
import { environment, fakeKagent, operator } from "./harness.js";

const page = { query: "", pageSize: 1, pageToken: "" };
const reader = { subject: operator.subject, administrator: false };

it("filters the operation state and participating member together, including paused descendants", async () => {
  const { projection, reconcile, close } = await environment(pendingApprovalTasks());
  const list = (request: Parameters<typeof projection.operations>[1]) =>
    projection.operations(reader, request);
  try {
    await reconcile.refresh();
    const pending = await list({ ...page, states: [ActivityState.AWAITING_APPROVAL] });
    expect(pending.tasks.map((task) => task.id)).toEqual([ids.approvalRoot]);
    expect(pending.totalSize).toBe(1);
    expect(
      (
        await list({
          ...page,
          states: [ActivityState.AWAITING_APPROVAL],
          engineer: "agentos/remediation",
        })
      ).tasks,
    ).toEqual(pending.tasks);
    expect(
      (
        await list({
          ...page,
          states: [ActivityState.AWAITING_APPROVAL],
          engineer: "agentos/inspection",
        })
      ).totalSize,
    ).toBe(0);
    expect(
      (await list({ ...page, states: [ActivityState.SUCCEEDED, ActivityState.AWAITING_APPROVAL] }))
        .totalSize,
    ).toBeGreaterThan(1);
  } finally {
    await close();
  }
});

it("binds cursors to normalized states and members", async () => {
  const { projection, reconcile, close } = await environment(pendingApprovalTasks());
  const list = (request: Parameters<typeof projection.operations>[1]) =>
    projection.operations(reader, request);
  try {
    await reconcile.refresh();
    const states = [ActivityState.SUCCEEDED, ActivityState.AWAITING_APPROVAL];
    const first = await list({ ...page, states });
    expect(first.nextPageToken).not.toBe("");
    const request = { ...page, pageToken: first.nextPageToken, states };
    expect((await list({ ...request, states: [...states].reverse() })).tasks).toEqual(
      (await list(request)).tasks,
    );
    await expect(list({ ...request, states: [ActivityState.SUCCEEDED] })).rejects.toThrow(
      "pagination.invalidPage",
    );
    await expect(list({ ...request, engineer: "agentos/remediation" })).rejects.toThrow(
      "pagination.invalidPage",
    );
    await expect(list({ ...request, states: [] })).rejects.toThrow("pagination.invalidPage");
  } finally {
    await close();
  }
});

async function runningTree() {
  const env = await environment();
  for (const id of [ids.dispatchRoot, ids.inspection, ids.background])
    env.fake.update(env.fake.task(id), TaskState.WORKING);
  await env.reconcile.refresh();
  const graph = await env.projection.graphOf({ taskId: ids.dispatchRoot });
  const tree = graph && taskTree(graph, ids.dispatchRoot);
  if (!tree) throw new Error("missing operation tree");
  const state = async (id: string) => (await env.projection.entry(id))?.state;
  return { ...env, tree, state };
}

it("cancels all unfinished delegated tasks, including background work, and is repeatable", async () => {
  const { clients, projection, state, close, tree, fake } = await runningTree();
  const cancel = vi.spyOn(clients.a2a, "cancelTask");
  try {
    await cancelTree(clients, projection, tree);
    expect(cancel.mock.calls.map(([request]) => request.id)).toEqual(
      expect.arrayContaining([ids.dispatchRoot, ids.inspection, ids.background]),
    );
    expect(await state(ids.inspection)).toBe(TaskState.CANCELED);
    expect(fake.task(ids.background).status?.state).toBe(TaskState.CANCELED);
    const graph = await projection.graphOf({ taskId: ids.dispatchRoot });
    const again = graph && taskTree(graph, ids.dispatchRoot);
    if (!graph || !again) throw new Error("missing operation");
    expect(taskSummary(graph, again).state).toBe(ActivityState.CANCELED);
    const count = cancel.mock.calls.length;
    await cancelTree(clients, projection, again);
    expect(cancel).toHaveBeenCalledTimes(count);
  } finally {
    await close();
  }
});

it("attempts every cancellation and keeps native successes when one task fails", async () => {
  const { clients, projection, state, close, tree } = await runningTree();
  const native = clients.a2a.cancelTask;
  const cancel = vi
    .spyOn(clients.a2a, "cancelTask")
    .mockImplementation(async (request, options) => {
      if (request.id === ids.dispatchRoot) throw new Error("native cancellation failed");
      return native(request, options);
    });
  try {
    await expect(cancelTree(clients, projection, tree)).rejects.toThrow(
      "native cancellation failed",
    );
    expect(cancel).toHaveBeenCalledWith(
      expect.objectContaining({ id: ids.inspection }),
      expect.anything(),
    );
    expect(await state(ids.inspection)).toBe(TaskState.CANCELED);
    expect(await state(ids.dispatchRoot)).toBe(TaskState.WORKING);
  } finally {
    await close();
  }
});

it("cancels unanswered tasks in one native session without overlapping its actor commands", async () => {
  const { clients, projection, reconcile, state, close, fake } = await runningTree();
  const question = fake.task(ids.inspection);
  const approval = clone(TaskSchema, question);
  approval.id = "pending-approval";
  approval.history = approval.history.map((message) => ({
    ...message,
    messageId: `approval-${message.messageId}`,
  })) as typeof approval.history;
  fake.update(question, TaskState.INPUT_REQUIRED);
  fake.update(approval, TaskState.AUTH_REQUIRED);
  await reconcile.refresh();
  const tree = {
    entries: await Promise.all(
      [ids.dispatchRoot, ids.inspection, ids.background, approval.id].map(async (id) => {
        const entry = await projection.entry(id);
        if (!entry) throw new Error("missing operation task");
        return entry;
      }),
    ),
  };
  const native = clients.a2a.cancelTask;
  const sessions = new Set<string>();
  let concurrency = 0;
  vi.spyOn(clients.a2a, "cancelTask").mockImplementation(async (request, options) => {
    const contextId = fake.task(request.id ?? "").contextId;
    if (sessions.has(contextId))
      throw new ConnectError("session actor is handling cancellation", Code.InvalidArgument);
    sessions.add(contextId);
    concurrency = Math.max(concurrency, sessions.size);
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      return await native(request, options);
    } finally {
      sessions.delete(contextId);
    }
  });
  try {
    await cancelTree(clients, projection, tree);
    expect(concurrency).toBeGreaterThan(1);
    for (const entry of tree.entries) expect(await state(entry.id)).toBe(TaskState.CANCELED);
    expect(fake.received).toEqual([]);
  } finally {
    await close();
  }
});

it("projects native run starts in summaries and full execution details", async () => {
  const { projection, reconcile, close } = await environment();
  try {
    await reconcile.refresh();
    const graph = await projection.graphOf({ taskId: ids.dispatchRoot });
    const tree = graph && taskTree(graph, ids.dispatchRoot);
    if (!tree) throw new Error("missing operation");
    for (const entry of tree.entries) {
      const run = runSummary(entry, tree.background.has(entry.id));
      expect(run.startedAt && timestampMs(run.startedAt)).toBe(entry.createdAt);
      const full = await taskRun(entry, projection.fullTask);
      expect(full?.startedAt).toEqual(run.startedAt);
    }
  } finally {
    await close();
  }
});

it("accepts a native task that finishes between reading the tree and canceling it", async () => {
  const { clients, projection, state, close, tree, fake } = await runningTree();
  const native = clients.a2a.cancelTask;
  vi.spyOn(clients.a2a, "cancelTask").mockImplementation(async (request, options) => {
    if (request.id !== ids.inspection) return native(request, options);
    fake.update(fake.task(ids.inspection), TaskState.COMPLETED);
    throw new ConnectError("task is already complete", Code.FailedPrecondition);
  });
  try {
    await cancelTree(clients, projection, tree);
    expect(await state(ids.inspection)).toBe(TaskState.COMPLETED);
    expect(await state(ids.dispatchRoot)).toBe(TaskState.CANCELED);
  } finally {
    await close();
  }
});

it("does not report success before native execution acknowledges cancellation", async () => {
  const { clients, projection, close, tree } = await runningTree();
  vi.spyOn(clients.a2a, "cancelTask").mockImplementation((request) =>
    clients.a2a.getTask({ id: request.id, tenant: request.tenant }),
  );
  try {
    await expect(cancelTree(clients, projection, tree)).rejects.toMatchObject({
      code: Code.FailedPrecondition,
    });
  } finally {
    await close();
  }
});

it("keeps a canceled fake execution from completing on its pending timer", async () => {
  vi.useFakeTimers();
  const { fake, clients } = fakeKagent();
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
    vi.useRealTimers();
  }
});
