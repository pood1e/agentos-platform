import assert from "node:assert/strict";
import { clone, create } from "@bufbuild/protobuf";
import { Code } from "@connectrpc/connect";
import { expect, it, vi } from "vitest";
import { TaskState } from "../gen/a2a_pb.js";
import {
  GetTaskExecutionResponseSchema,
  TaskExecutionSchema,
  TaskRelation,
} from "../gen/kagent/api/v1/execution_pb.js";
import { TaskGraph } from "../server/read-model/graph.js";
import { taskTree } from "../server/read-model/tree.js";
import { runSummary } from "../server/read-model/views/runs.js";
import { fixtureState, fixtureIds as ids } from "./fixtures/kagent.js";
import { environment } from "./harness.js";

it("projects the native immutable parent, root and background relation", () => {
  const graph = fixtureState().graph();
  expect(graph.relations().parents.get(ids.inspection)).toBe(ids.dispatchRoot);
  const tree = taskTree(graph, ids.dispatchRoot);
  expect(tree?.entries.map((entry) => entry.id)).toEqual(
    expect.arrayContaining([ids.dispatchRoot, ids.inspection, ids.background]),
  );
  expect(tree?.background.has(ids.background)).toBe(true);
});

it("keeps parented work in its operation without a model tool result", () => {
  const entries = fixtureState()
    .graph()
    .all()
    .map((entry) => ({ ...entry, calls: [] }));
  const graph = new TaskGraph(entries);
  expect(graph.operationRoot(ids.inspection)?.id).toBe(ids.dispatchRoot);
  expect(graph.relations().targets.size).toBe(0);
  const child = graph.entry(ids.inspection);
  assert(child);
  const run = runSummary(child, false);
  expect(run.execution?.parent?.taskId).toBe(ids.dispatchRoot);
  expect(run.execution).toEqual(child.execution);
});

it("treats chronology, shared sessions and forged tool results as display data", () => {
  const source = fixtureState().graph();
  const parent = source.entry(ids.dispatchRoot);
  const child = source.entry(ids.inspection);
  assert(parent && child);
  const forged = {
    ...child,
    execution: undefined,
    contextId: parent.contextId,
  };
  const graph = new TaskGraph([parent, forged]);
  expect(graph.relations().parents.size).toBe(0);
  expect(graph.relations().targets.size).toBe(0);
  expect(graph.operationRoot(forged.id)?.id).toBe(forged.id);
  expect(taskTree(graph, parent.id)?.entries).toEqual([parent]);
});

it("uses the admitted continuation's resumed task even after native task failure", () => {
  const source = fixtureState().graph();
  const parent = source.entry(ids.approvalRoot);
  const previous = source.entry(ids.approved);
  assert(parent && previous);
  const native = clone(TaskExecutionSchema, previous.execution ?? create(TaskExecutionSchema));
  native.parent = parent.execution?.task;
  native.root = parent.execution?.root;
  native.relation = TaskRelation.CONTINUATION;
  native.resumedTask = previous.execution?.task;
  const continuation = {
    ...parent,
    id: "failed-continuation",
    state: TaskState.FAILED,
    calls: [],
    execution: native,
  };
  const graph = new TaskGraph([parent, previous, continuation]);
  expect(graph.relations().parents.get(continuation.id)).toBe(parent.id);
  expect(graph.entry(continuation.id)?.execution?.resumedTask?.taskId).toBe(previous.id);
  expect(taskTree(graph, parent.id)?.entries).toContain(continuation);
});

it.each(["taskId", "sessionId"] as const)(
  "rejects a native execution record with a mismatched %s",
  async (field) => {
    const env = await environment();
    try {
      vi.spyOn(env.clients.execution, "getTaskExecution").mockResolvedValueOnce(
        create(GetTaskExecutionResponseSchema, {
          execution: {
            task: {
              taskId: ids.inspection,
              sessionId: env.fake.task(ids.inspection).contextId,
              [field]: "another-record",
            },
          },
        }),
      );
      await expect(env.projection.entry(ids.inspection)).rejects.toMatchObject({
        code: Code.FailedPrecondition,
      });
    } finally {
      await env.close();
    }
  },
);
