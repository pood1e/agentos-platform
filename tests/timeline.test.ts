import { create } from "@bufbuild/protobuf";
import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { expect, it } from "vitest";
import { InteractionKind, TaskDetailSchema } from "../gen/agentos/console/v1/task_pb.js";
import { ActivityState } from "../gen/agentos/execution/v1/state_pb.js";
import { timelineIntervals } from "../src/features/tasks/timeline.js";

it("retains execution, delegation and approval intervals and their drawer destinations", () => {
  const detail = create(TaskDetailSchema, {
    runs: [
      {
        taskId: "child",
        contextId: "session",
        agentId: "worker",
        state: ActivityState.SUCCEEDED,
        startedAt: timestampFromMs(20),
        updatedAt: timestampFromMs(100),
      },
    ],
    delegations: [
      {
        id: "delegate",
        sourceAgentId: "owner",
        sourceTaskId: "root",
        sourceContextId: "owner-session",
        targetTaskId: "child",
        targetContextId: "session",
        callId: "call",
        state: ActivityState.SUCCEEDED,
        startedAt: timestampFromMs(10),
        returnedAt: timestampFromMs(60),
        finishedAt: timestampFromMs(100),
        returned: true,
      },
    ],
    interactions: [
      {
        id: "approval",
        taskId: "child",
        agentId: "worker",
        kind: InteractionKind.APPROVAL,
        state: ActivityState.SUCCEEDED,
        requestedAt: timestampFromMs(40),
        answeredAt: timestampFromMs(80),
      },
    ],
  });
  expect(timelineIntervals(detail)).toMatchObject([
    {
      id: "delegate",
      kind: "delegation",
      startedAt: 10,
      endedAt: 60,
      open: false,
      target: { taskId: "root", callKey: "root:call" },
    },
    {
      id: "run:child",
      kind: "execution",
      startedAt: 20,
      endedAt: 100,
      target: { taskId: "child", contextId: "session" },
    },
    {
      id: "approval",
      kind: "approval",
      startedAt: 40,
      endedAt: 80,
      target: { interactionId: "approval" },
    },
  ]);
});

it("leaves running intervals open and missing timestamps unreported", () => {
  const detail = create(TaskDetailSchema, {
    runs: [
      {
        taskId: "active",
        agentId: "worker",
        state: ActivityState.WORKING,
        startedAt: timestampFromMs(0),
        updatedAt: timestampFromMs(100),
      },
      { taskId: "unknown-time", agentId: "worker", state: ActivityState.SUCCEEDED },
      {
        taskId: "background",
        agentId: "worker",
        state: ActivityState.CANCELED,
        background: true,
        startedAt: timestampFromMs(20),
        updatedAt: timestampFromMs(90),
      },
    ],
    interactions: [
      {
        id: "pending",
        kind: InteractionKind.APPROVAL,
        state: ActivityState.AWAITING_APPROVAL,
        requestedAt: timestampFromMs(30),
      },
    ],
  });
  const intervals = timelineIntervals(detail);
  expect(intervals.find((item) => item.id === "run:active")).toMatchObject({
    startedAt: 0,
    endedAt: undefined,
    open: true,
  });
  expect(intervals.find((item) => item.id === "pending")).toMatchObject({
    endedAt: undefined,
    open: true,
  });
  expect(intervals.find((item) => item.id === "run:background")).toMatchObject({
    endedAt: 90,
    open: false,
    background: true,
  });
  expect(intervals.at(-1)).toMatchObject({
    id: "run:unknown-time",
    startedAt: undefined,
    endedAt: undefined,
    open: false,
  });
});
