import assert from "node:assert/strict";
import { clone, create } from "@bufbuild/protobuf";
import { expect, it } from "vitest";
import { TaskState } from "../gen/a2a_pb.js";
import { TaskExecutionSchema, TaskRelation } from "../gen/kagent/api/v1/execution_pb.js";
import { TaskGraph } from "../server/read-model/graph.js";
import { taskTree } from "../server/read-model/tree.js";
import { fixtureState, fixtureIds as ids } from "./fixtures/kagent.js";

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
});

it("treats chronology, shared sessions and forged tool results as display data", () => {
  const source = fixtureState().graph();
  const parent = source.entry(ids.dispatchRoot);
  const child = source.entry(ids.inspection);
  assert(parent && child);
  const forged = {
    ...child,
    execution: undefined,
    parentTaskId: parent.id,
    resumedTaskId: parent.id,
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
  expect(graph.relations().continuations.get(parent.id)).toContain(continuation.id);
  expect(graph.relations().resumed.has(previous.id)).toBe(true);
  expect(taskTree(graph, parent.id)?.entries).toContain(continuation);
});
