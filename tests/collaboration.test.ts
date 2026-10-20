import { describe, expect, it } from "vitest";
import { ActivityState } from "../gen/agentos/execution/v1/state_pb.js";
import { collaborationFlow } from "../src/features/tasks/flow/collaboration-flow.js";
import { collaborationLayout } from "../src/features/tasks/flow/collaboration-layout.js";
import type { Link } from "../src/features/tasks/flow/links.js";
import { eventTime, sequenceFor } from "../src/features/tasks/flow/sequence.js";
import { collaborationDetail } from "./fixtures/collaboration.js";

const coordinator = "agentos/coordinator";
const root = { taskId: "task-coordinator", agentId: coordinator };

function link(id: string, startedAt?: number, endedAt?: number, fields: Partial<Link> = {}): Link {
  return {
    id,
    source: "coordinator",
    target: id,
    sourceTaskId: "root-task",
    sourceContextId: "context-coordinator",
    targetContextId: `context-${fields.target ?? id}`,
    targetTaskId: `task-${id}`,
    kind: "invoke",
    state: ActivityState.SUCCEEDED,
    startedAt,
    endedAt,
    dependsOn: [],
    returned: endedAt !== undefined,
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
      dependsOn:
        role === "remediation"
          ? ["delegate-inspection", "delegate-diagnosis"]
          : role === "knowledge"
            ? ["delegate-remediation"]
            : [],
    });
  return [
    step("inspection", 1_000, 16_000, 17_000),
    step("diagnosis", 2_000, 22_000, 23_000),
    step("remediation", 24_000, 29_000, 30_000),
    step("knowledge", 31_000, 33_000),
  ];
}

const layoutOf = (links: Link[]) =>
  collaborationLayout(
    collaborationFlow(
      collaborationDetail(links, { root: { ...root, contextId: "context-coordinator" } }),
    ),
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

describe("instance collaboration layout", () => {
  it("places initially independent instances in one row and later work below", async () => {
    const layout = await layoutOf(investigation());
    expect(layout.activities.map((activity) => activity.row)).toEqual([1, 2, 2, 3, 4]);
    expect(layout.activities[1]?.y).toBe(layout.activities[2]?.y);
    expect(layout.activities[3]?.y).toBeGreaterThan(layout.activities[2]?.y ?? 0);
    expect(layout.activities[4]?.y).toBeGreaterThan(layout.activities[3]?.y ?? 0);
    expect(layout.connections).toHaveLength(4);
    expect(
      layout.connections
        .flatMap((item) => item.records)
        .filter((item) => item.phase === "dispatch"),
    ).toHaveLength(4);
    expect(
      layout.connections.flatMap((item) => item.records).filter((item) => item.phase === "return"),
    ).toHaveLength(3);
  });

  it("keeps many independent contexts distinct even when they use the same engineer", async () => {
    const links = Array.from({ length: 12 }, (_, i) =>
      link(`member-${i}`, 1_000, 17_000, {
        source: coordinator,
        sourceTaskId: root.taskId,
        target: "agentos/inspection",
        targetContextId: `context-${i}`,
        finishedAt: 17_000,
      }),
    );
    const instances = (await layoutOf(links)).activities.filter((node) => !node.root);
    expect(instances).toHaveLength(12);
    expect(new Set(instances.map((node) => node.contextId)).size).toBe(12);
    expect(new Set(instances.map((node) => node.row))).toEqual(new Set([2]));
    expect(new Set(instances.map((node) => node.y)).size).toBe(1);
    expect(new Set(instances.map((node) => node.x)).size).toBe(12);
  });

  it("uses the originating context for nested delegation and return", async () => {
    const [first, second] = investigation();
    if (!first || !second) throw new Error("scenario");
    const nested = {
      ...second,
      id: "nested",
      source: first.target,
      sourceTaskId: first.targetTaskId ?? "",
      sourceContextId: first.targetContextId,
      targetContextId: "nested-context",
    };
    const layout = await layoutOf([first, nested]);
    expect(
      layout.connections
        .flatMap((edge) => edge.records)
        .find((edge) => edge.phase === "dispatch" && edge.step.link.id === "nested")?.source,
    ).toBe(`session:${first.targetContextId}`);
    expect(
      layout.connections
        .flatMap((edge) => edge.records)
        .find((edge) => edge.phase === "return" && edge.step.link.id === "nested")?.target,
    ).toBe(`session:${first.targetContextId}`);
  });

  it("keeps topology and coordinates stable across status-only updates", async () => {
    const before = await layoutOf(investigation());
    const after = await layoutOf(
      investigation().map((item) => ({ ...item, state: ActivityState.WORKING })),
    );
    expect(after.key).toBe(before.key);
    expect(after.activities.map(({ id, x, y }) => [id, x, y])).toEqual(
      before.activities.map(({ id, x, y }) => [id, x, y]),
    );
  });

  it("does not invent a return for a handoff or background dispatch", async () => {
    const [first] = investigation();
    if (!first) throw new Error("scenario");
    for (const kind of ["handoff", "background"] as const) {
      const layout = await layoutOf([{ ...first, kind }]);
      expect(
        layout.connections
          .flatMap((edge) => edge.records)
          .filter((edge) => edge.phase === "return"),
      ).toHaveLength(0);
    }
  });

  it("keeps one context in one node and empty observations empty", async () => {
    expect((await layoutOf([])).activities).toHaveLength(1);
    const empty = await collaborationLayout(
      collaborationFlow(collaborationDetail([], { root: null })),
    );
    expect(empty.activities).toEqual([]);
  });
});
