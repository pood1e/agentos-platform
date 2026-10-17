import { create } from "@bufbuild/protobuf";
import { type Timestamp, timestampFromMs } from "@bufbuild/protobuf/wkt";
import { ActivityState } from "../../../gen/agentos/console/v1/state_pb.js";
import {
  InteractionKind,
  type TaskRun,
  TaskRunSchema,
} from "../../../gen/agentos/console/v1/task_pb.js";
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

export const runSummary = (entry: TaskEntry, background: boolean): TaskRun =>
  create(TaskRunSchema, {
    taskId: entry.id,
    agentId: entry.agentId,
    contextId: entry.contextId,
    state: runState(entry),
    background,
    updatedAt: stamp(entry.statusAt),
  });
