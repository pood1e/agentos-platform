import { create } from "@bufbuild/protobuf";
import { timestampMs } from "@bufbuild/protobuf/wkt";
import { expect, it, vi } from "vitest";
import { MessageSchema, Role, TaskState } from "../gen/a2a_pb.js";
import { ActivityState } from "../gen/agentos/execution/v1/state_pb.js";
import { taskTree } from "../server/read-model/tree.js";
import { taskRun } from "../server/read-model/views/run.js";
import { runSummary } from "../server/read-model/views/runs.js";
import { pendingApprovalTasks } from "./fake-kagent/scenario.js";
import { fixtureIds as ids } from "./fixtures/kagent.js";
import { environment, fakeKagent, operator } from "./harness.js";

const page = { query: "", pageSize: 1, pageToken: "" };
const reader = { subject: operator.subject, administrator: false };

it("filters the operation state and participating member together, including paused descendants", async () => {
  const { projection, close } = await environment(pendingApprovalTasks());
  const list = (request: Parameters<typeof projection.operations>[1]) =>
    projection.operations(reader, request);
  try {
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
  const { projection, close } = await environment(pendingApprovalTasks());
  const list = (request: Parameters<typeof projection.operations>[1]) =>
    projection.operations(reader, request);
  try {
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

it("projects native run starts in summaries and full execution details", async () => {
  const { projection, close } = await environment();
  try {
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
