import { describe, expect, it } from "vitest";
import { ActivityState } from "../gen/agentos/console/v1/state_pb.js";
import { collaborationFlow } from "../src/features/tasks/flow/collaboration-flow.js";
import {
  activityHeight,
  collaborationLayout,
} from "../src/features/tasks/flow/collaboration-layout.js";
import type { Link } from "../src/features/tasks/flow/links.js";
import { eventTime, sequenceFor } from "../src/features/tasks/flow/sequence.js";

const coordinator = "agentos/coordinator";
const root = { taskId: "task-coordinator", agentId: coordinator };
const window = { start: 1_000, completedAt: 32_000 };

function link(id: string, startedAt?: number, endedAt?: number, fields: Partial<Link> = {}): Link {
  return {
    id,
    source: "coordinator",
    target: id,
    sourceTaskId: "root-task",
    targetTaskId: `task-${id}`,
    kind: "invoke",
    state: ActivityState.SUCCEEDED,
    startedAt,
    endedAt,
    ...fields,
  };
}

/** Inspection and diagnosis in parallel, then remediation, then background knowledge. */
function investigation(): Link[] {
  const step = (role: string, startedAt: number, finishedAt: number, endedAt?: number) =>
    link(`delegate-${role}`, startedAt, endedAt, {
      source: coordinator,
      target: `agentos/${role}`,
      sourceTaskId: root.taskId,
      targetTaskId: `task-${role}`,
      callKey: `${root.taskId}:delegate-${role}`,
      finishedAt,
      kind: endedAt === undefined ? "background" : "invoke",
    });
  return [
    step("inspection", 1_000, 16_000, 17_000),
    step("diagnosis", 2_000, 22_000, 23_000),
    step("remediation", 24_000, 29_000, 30_000),
    step("knowledge", 31_000, 33_000),
  ];
}

const participants = (links: Link[]) => [coordinator, ...new Set(links.map((item) => item.target))];
const layoutOf = (links: Link[], agents = participants(links)) =>
  collaborationLayout(
    collaborationFlow({ participants: agents, links, root, window, interactions: [] }),
  );

describe("observed collaboration sequence", () => {
  it("orders real dispatches and separates parallel work from later serial work", () => {
    const steps = sequenceFor(investigation().toReversed(), 40_000);
    expect(steps.map((step) => [step.order, step.link.target])).toEqual([
      [1, "agentos/inspection"],
      [2, "agentos/diagnosis"],
      [3, "agentos/remediation"],
      [4, "agentos/knowledge"],
    ]);
    expect(steps.map((step) => step.parallel.length)).toEqual([1, 1, 0, 0]);
  });

  it("keeps repeated dispatches to the same agent, including failures, as separate steps", () => {
    const steps = sequenceFor([
      link("retry", 20, 30, { target: "diagnosis" }),
      link("first", 1, 10, { target: "diagnosis", state: ActivityState.FAILED }),
    ]);
    expect(steps.map((step) => [step.link.id, step.order, step.occurrence])).toEqual([
      ["first", 1, 1],
      ["retry", 2, 2],
    ]);
  });

  it("compares overlaps pair by pair instead of merging an overlapping chain", () => {
    const steps = sequenceFor([link("a", 0, 10), link("b", 5, 15), link("c", 11, 20)]);
    expect(steps.map((step) => step.parallel)).toEqual([["b"], ["a", "c"], ["b"]]);
  });

  it("does not confuse nested delegation with parallel branches", () => {
    const steps = sequenceFor([
      link("a", 0, 100),
      link("b", 10, 80, { source: "a", sourceTaskId: "task-a" }),
      link("c", 20, 60, { source: "b", sourceTaskId: "task-b" }),
      link("d", 15, 70),
    ]);
    expect(steps.find((step) => step.link.id === "a")?.parallel).toEqual(["d"]);
    expect(steps.find((step) => step.link.id === "d")?.parallel).toEqual(["a", "b", "c"]);
  });

  it("bounds ongoing overlap by the observation time and leaves missing times unknown", () => {
    const steps = sequenceFor(
      [
        link("active", 0, undefined, { state: ActivityState.WORKING }),
        link("later", 5, 10),
        link("missing", undefined, 12),
      ],
      8,
    );
    expect(steps.find((step) => step.link.id === "active")?.parallel).toEqual(["later"]);
    expect(steps.find((step) => step.link.id === "missing")).toMatchObject({
      order: undefined,
      parallel: [],
    });
    expect(eventTime(link("invalid", 20, 15), "returned")).toBeUndefined();
  });

  it("uses child completion instead of batched return timestamps for parallelism", () => {
    const steps = sequenceFor([
      link("first", 0, 100, { finishedAt: 10 }),
      link("later", 20, 100, { finishedAt: 30 }),
    ]);
    expect(steps.map((step) => step.parallel)).toEqual([[], []]);
  });
});

describe("left-to-right collaboration steps", () => {
  it("places parallel branches in one column and advances later delegations", () => {
    const layout = layoutOf(investigation());
    const executions = layout.activities.filter((activity) => activity.step);
    expect(executions.map((activity) => activity.column)).toEqual([2, 2, 4, 6]);
    expect(executions[0]?.x).toBe(executions[1]?.x);
    expect(layout.connections.filter((item) => item.phase === "dispatch")).toHaveLength(4);
    expect(layout.connections.filter((item) => item.phase === "return")).toHaveLength(3);
    for (const connection of layout.connections) {
      const source = layout.activities.find((activity) => activity.id === connection.source);
      const target = layout.activities.find((activity) => activity.id === connection.target);
      expect(source?.x).toBeLessThan(target?.x ?? 0);
    }
  });

  it("centers every column on one horizontal line", () => {
    const layout = layoutOf(investigation());
    const columns = [...new Set(layout.activities.map((activity) => activity.column))].map(
      (column) => layout.activities.filter((activity) => activity.column === column),
    );
    const centers = columns.map(
      (column) =>
        (Math.min(...column.map((activity) => activity.y)) +
          Math.max(...column.map((activity) => activity.y + activityHeight))) /
        2,
    );
    expect(new Set(centers).size).toBe(1);
  });

  it("keeps members sharing a role distinct and centers many parallel participants", () => {
    const links = Array.from({ length: 12 }, (_, index) =>
      link(`member-${index}`, 1_000, 17_000, {
        source: coordinator,
        sourceTaskId: root.taskId,
        target: `agentos/inspection-${index}`,
        finishedAt: 17_000,
      }),
    );
    const executions = layoutOf(links).activities.filter(
      (activity) => activity.kind === "execution",
    );
    expect(new Set(executions.map((activity) => activity.agentId)).size).toBe(12);
    expect(new Set(executions.map((activity) => activity.column))).toEqual(new Set([2]));
  });

  it("attaches nested delegations to their actual invocation", () => {
    const [first, second] = investigation();
    if (!first?.targetTaskId || !second) throw new Error("scenario");
    const nested: Link = {
      ...second,
      id: "nested",
      source: first.target,
      sourceTaskId: first.targetTaskId,
      startedAt: 3_000,
      finishedAt: 9_000,
      endedAt: 10_000,
    };
    const layout = layoutOf([first, nested]);
    expect(layout.connections.find((edge) => edge.id === "dispatch:nested")?.source).toBe(first.id);
    expect(layout.connections.find((edge) => edge.id === `return:${first.id}`)?.source).toBe(
      "resume:nested",
    );
  });

  it("keeps topology and coordinates stable across status-only updates", () => {
    const before = layoutOf(investigation());
    const after = layoutOf(
      investigation().map((item) => ({ ...item, state: ActivityState.WORKING })),
    );
    expect(after.key).toBe(before.key);
    expect(after.activities.map(({ id, x, y }) => [id, x, y])).toEqual(
      before.activities.map(({ id, x, y }) => [id, x, y]),
    );
  });

  it("does not invent a result-return path for handoffs", () => {
    const [first] = investigation();
    if (!first) throw new Error("scenario");
    const layout = layoutOf([{ ...first, kind: "handoff" }]);
    expect(layout.activities.filter((activity) => activity.kind === "resume")).toHaveLength(0);
  });

  it("shows a single-agent task as one column and keeps an empty observation empty", () => {
    const single = layoutOf([], [coordinator]);
    expect(single.activities).toHaveLength(1);
    expect(single.activities[0]).toMatchObject({
      root: true,
      final: true,
      column: 1,
      endedAt: 32_000,
    });
    const empty = collaborationLayout(
      collaborationFlow({ participants: [], links: [], window: {}, interactions: [] }),
    );
    expect(empty.activities).toEqual([]);
  });
});
