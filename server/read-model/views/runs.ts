import { create } from "@bufbuild/protobuf";
import { type Timestamp, timestampFromMs } from "@bufbuild/protobuf/wkt";
import { InteractionKind } from "../../../gen/agentos/console/v1/task_pb.js";
import { ActivityState } from "../../../gen/agentos/execution/v1/state_pb.js";
import { type TaskRun, TaskRunSchema } from "../../../gen/agentos/execution/v1/task_pb.js";
import type { TaskEntry } from "../entry.js";
import { taskActivity } from "../state.js";

export const stamp = (ms?: number): Timestamp | undefined =>
  ms === undefined ? undefined : timestampFromMs(ms);

export const pendingApproval = (entry: TaskEntry) =>
  entry.interactions.some(
    (item) =>
      item.kind === InteractionKind.APPROVAL && item.state === ActivityState.AWAITING_APPROVAL,
  );

export const runState = (entry: TaskEntry) =>
  pendingApproval(entry) ? ActivityState.AWAITING_APPROVAL : taskActivity(entry.state);

export const running = (entry: TaskEntry) =>
  [ActivityState.SUBMITTED, ActivityState.WORKING].includes(runState(entry));

export const runSummary = (entry: TaskEntry, background: boolean): TaskRun =>
  create(TaskRunSchema, {
    taskId: entry.id,
    agentId: entry.agentId,
    contextId: entry.contextId,
    state: runState(entry),
    background,
    execution: entry.execution,
    startedAt: stamp(entry.createdAt),
    updatedAt: stamp(entry.statusAt),
  });
