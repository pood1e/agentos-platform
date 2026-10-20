import { create } from "@bufbuild/protobuf";
import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { describe, expect, it } from "vitest";
import { EngineerSchema } from "../gen/agentos/console/v1/engineer_pb.js";
import { ActivityState } from "../gen/agentos/console/v1/state_pb.js";
import { InteractionKind, InteractionSchema } from "../gen/agentos/console/v1/task_pb.js";
import {
  collaborationFlow,
  instanceNodeId,
} from "../src/features/tasks/flow/collaboration-flow.js";
import { collaborationLayout } from "../src/features/tasks/flow/collaboration-layout.js";
import { connectionSteps, currentStep } from "../src/features/tasks/flow/connection-bundles.js";
import { instanceNames } from "../src/features/tasks/flow/instance-names.js";
import type { Link } from "../src/features/tasks/flow/links.js";
import { collaborationDetail, link, root } from "./fixtures/collaboration.js";

const layout = (links: Link[]) =>
  collaborationLayout(collaborationFlow(collaborationDetail(links)));

describe("observed instance collaboration", () => {
  it("keeps independent work in the same row despite nonoverlapping clock ranges", async () => {
    const graph = await layout([
      link("a", { startedAt: 1, endedAt: 10 }),
      link("b", { startedAt: 11, endedAt: 20 }),
    ]);
    expect(graph.activities.filter((node) => !node.root).map((node) => node.row)).toEqual([2, 2]);
    expect(graph.activities[1]?.y).toBe(graph.activities[2]?.y);
    expect(graph.activities[1]?.x).not.toBe(graph.activities[2]?.x);
    expect(graph.activities[1]?.y).toBeGreaterThan(graph.activities[0]?.y ?? 0);
  });

  it("orders first participation using partial and full reply dependencies", async () => {
    const graph = await layout([
      link("a"),
      link("b"),
      link("c", { dependsOn: ["a"] }),
      link("d", { dependsOn: ["b", "c"] }),
    ]);
    expect(graph.activities.map((node) => node.row)).toEqual([1, 2, 2, 3, 4]);
    expect(graph.activities[3]?.y).toBeGreaterThan(graph.activities[1]?.y ?? 0);
    expect(graph.activities[4]?.y).toBeGreaterThan(graph.activities[3]?.y ?? 0);
    const joined = graph.connections.flatMap(connectionSteps).find(({ link }) => link.id === "d");
    expect(joined?.link.dependsOn).toEqual(["b", "c"]);
  });

  it("uses observed replies rather than child completion timestamps for placement", async () => {
    const graph = await layout([
      link("a", { startedAt: 1, finishedAt: 10, endedAt: 100 }),
      link("b", { startedAt: 20, finishedAt: 30, endedAt: 100 }),
    ]);
    expect(graph.activities.filter((node) => !node.root).map((node) => node.row)).toEqual([2, 2]);
  });

  it("keeps asynchronous knowledge independent of the main instance state", async () => {
    const graph = await layout([
      link("a"),
      link("knowledge", {
        kind: "background",
        returned: false,
        state: ActivityState.WORKING,
        dependsOn: ["a"],
      }),
    ]);
    expect(
      graph.connections
        .flatMap((edge) => edge.records)
        .some((edge) => edge.phase === "return" && edge.step.link.id === "knowledge"),
    ).toBe(false);
    expect(graph.activities.find((node) => node.root)?.state).toBe(ActivityState.SUCCEEDED);
    expect(graph.activities.find((node) => node.contextId === "context-knowledge")?.state).toBe(
      ActivityState.WORKING,
    );
  });

  it("reuses one context for multiple tasks and recovers from a previous failed attempt", async () => {
    const graph = await layout([
      link("first", {
        target: "diagnosis",
        startedAt: 1,
        endedAt: 10,
        state: ActivityState.FAILED,
      }),
      link("retry", { target: "diagnosis", startedAt: 20, endedAt: 30, dependsOn: ["first"] }),
    ]);
    expect(graph.activities).toHaveLength(2);
    const instance = graph.activities.find((node) => node.contextId === "context-diagnosis");
    expect(instance?.taskIds).toEqual(["task-first", "task-retry"]);
    expect(instance?.state).toBe(ActivityState.SUCCEEDED);
    expect(
      graph.connections
        .flatMap((edge) => edge.records)
        .filter((edge) => edge.phase === "dispatch")
        .map(({ step }) => step.link.id),
    ).toEqual(["first", "retry"]);
    expect(
      graph.connections.flatMap((edge) => edge.records).find((edge) => edge.phase === "return")
        ?.target,
    ).toBe(instanceNodeId(root.contextId));
  });

  it("keeps contexts of the same engineer separate, including their states and task histories", async () => {
    const graph = await layout([
      link("first", {
        target: "diagnosis",
        targetContextId: "instance-a",
        state: ActivityState.FAILED,
      }),
      link("second", {
        target: "diagnosis",
        targetContextId: "instance-b",
        state: ActivityState.WORKING,
        returned: false,
      }),
    ]);
    const instances = graph.activities.filter((node) => node.agentId === "diagnosis");
    expect(instances).toHaveLength(2);
    expect(
      instances.map(({ contextId, state, taskIds }) => ({ contextId, state, taskIds })),
    ).toEqual([
      { contextId: "instance-a", state: ActivityState.FAILED, taskIds: ["task-first"] },
      { contextId: "instance-b", state: ActivityState.WORKING, taskIds: ["task-second"] },
    ]);
  });

  it("keeps an idempotent repeated invocation visible without duplicating the instance or task", async () => {
    const graph = await layout([
      link("first", { target: "diagnosis", targetTaskId: "same-task" }),
      link("retry", { target: "diagnosis", targetTaskId: "same-task", dependsOn: ["first"] }),
    ]);
    expect(graph.activities).toHaveLength(2);
    expect(graph.activities.find((node) => !node.root)?.taskIds).toEqual(["same-task"]);
    expect(graph.connections).toHaveLength(1);
    expect(graph.connections.flatMap(connectionSteps)).toHaveLength(2);
  });

  it("can show a target Session before its first Task arrives", async () => {
    const graph = await layout([
      link("starting", {
        targetTaskId: undefined,
        targetContextId: "new-instance",
        state: ActivityState.WORKING,
        returned: false,
      }),
    ]);
    expect(graph.activities.find((node) => node.contextId === "new-instance")).toMatchObject({
      taskIds: [],
      state: ActivityState.WORKING,
    });
    const unresolved = await layout([
      link("unknown", { targetTaskId: undefined, targetContextId: "" }),
    ]);
    expect(unresolved.activities).toHaveLength(1);
  });

  it("attaches approval and its decision to the exact context of the requesting task", async () => {
    const approval = create(InteractionSchema, {
      id: "pause",
      taskId: "task-second",
      agentId: "diagnosis",
      kind: InteractionKind.APPROVAL,
      state: ActivityState.SUCCEEDED,
      requestedAt: timestampFromMs(10),
      answeredAt: timestampFromMs(20),
    });
    const flow = collaborationFlow(
      collaborationDetail(
        [
          link("first", { target: "diagnosis", targetContextId: "instance-a" }),
          link("second", { target: "diagnosis", targetContextId: "instance-b" }),
        ],
        { interactions: [approval] },
      ),
    );
    expect(flow.connections.find((edge) => edge.phase === "approval")?.source).toBe(
      instanceNodeId("instance-b"),
    );
    expect(flow.connections.find((edge) => edge.source === "interaction:pause")?.target).toBe(
      instanceNodeId("instance-b"),
    );
    expect(flow.activities.filter((node) => node.kind === "engineer")).toHaveLength(3);
  });

  it("uses one native Bezier and independent ports for each pair of instances", async () => {
    const graph = await layout([
      link("a"),
      link("b"),
      link("c", { dependsOn: ["a"] }),
      link("d", { dependsOn: ["b", "c"] }),
    ]);
    const returning = graph.connections
      .flatMap((edge) => edge.records)
      .filter((edge) => edge.phase === "return");
    expect(returning).toHaveLength(4);
    expect(graph.connections).toHaveLength(4);
    for (const edge of graph.connections) {
      expect(edge.route.path.match(/C/g)).toHaveLength(1);
      expect(edge.route.path).not.toMatch(/[LQHV]/);
      expect(
        graph.activities
          .find((node) => node.id === edge.source)
          ?.handles.some((handle) => handle.id === edge.route.sourceHandle),
      ).toBe(true);
      expect(
        graph.activities
          .find((node) => node.id === edge.target)
          ?.handles.some((handle) => handle.id === edge.route.targetHandle),
      ).toBe(true);
    }
  });

  it("names same-role contexts distinctly and honors native instance names", () => {
    const flow = collaborationFlow(
      collaborationDetail([
        link("first", { target: "inspection", targetContextId: "a" }),
        link("second", { target: "inspection", targetContextId: "b" }),
      ]),
    );
    const agents = [create(EngineerSchema, { id: "inspection", role: "inspection" })];
    const names = instanceNames(flow.activities, agents);
    expect(names.get(instanceNodeId("a"))).toMatch(/ · 1$/);
    expect(names.get(instanceNodeId("b"))).toMatch(/ · 2$/);
    const named = collaborationFlow(
      collaborationDetail([link("first", { target: "inspection", targetContextId: "a" })], {
        names: { a: "网络核验" },
      }),
    );
    expect(instanceNames(named.activities, agents).get(instanceNodeId("a"))).toBe("网络核验");
  });

  it("shares one curve across repeated round trips while preserving every native event and ordinal", async () => {
    const graph = await layout(
      Array.from({ length: 6 }, (_, index) =>
        link(String(index), {
          target: "inspection",
          startedAt: index * 1000,
          endedAt: index * 1000 + 500,
        }),
      ),
    );
    expect(graph.activities).toHaveLength(2);
    expect(graph.connections).toHaveLength(1);
    const connection = graph.connections[0];
    expect(connection?.records).toHaveLength(12);
    expect(connection && connectionSteps(connection).map((step) => step.order)).toEqual([
      1, 2, 3, 4, 5, 6,
    ]);
    for (let order = 1; order <= 6; order++) {
      const pair = connection?.records.filter((edge) => edge.step.order === order) ?? [];
      expect(pair.map((edge) => edge.phase)).toEqual(["dispatch", "return"]);
      expect(pair[0]?.source).toBe(pair[1]?.target);
      expect(pair[0]?.target).toBe(pair[1]?.source);
    }
    expect(
      new Set(
        graph.connections.flatMap((edge) => [edge.route.sourceHandle, edge.route.targetHandle]),
      ).size,
    ).toBe(2);
  });

  it("preserves geometry when a pair gains another round and uses the recovered current state", async () => {
    const first = link("first", {
      target: "inspection",
      state: ActivityState.FAILED,
      startedAt: 1,
      endedAt: 2,
    });
    const before = await layout([first]);
    const after = await layout([
      first,
      link("retry", { target: "inspection", startedAt: 3, endedAt: 4 }),
    ]);
    expect(after.key).toBe(before.key);
    expect(after.activities.map(({ id, x, y }) => ({ id, x, y }))).toEqual(
      before.activities.map(({ id, x, y }) => ({ id, x, y })),
    );
    expect(currentStep(after.connections.flatMap(connectionSteps))?.link.state).toBe(
      ActivityState.SUCCEEDED,
    );
  });

  it("preserves who called whom when the two instances both initiate work", async () => {
    const graph = await layout([
      link("outbound", { target: "inspection", startedAt: 1, endedAt: 2 }),
      link("inbound", {
        source: "inspection",
        sourceContextId: "context-inspection",
        sourceTaskId: "task-outbound",
        target: root.agentId,
        targetContextId: root.contextId,
        targetTaskId: "root-followup",
        startedAt: 3,
        endedAt: 4,
      }),
    ]);
    expect(graph.connections).toHaveLength(1);
    const steps = graph.connections.flatMap(connectionSteps);
    expect(steps.map(({ link }) => [link.sourceContextId, link.targetContextId])).toEqual([
      [root.contextId, "context-inspection"],
      ["context-inspection", root.contextId],
    ]);
  });
});
