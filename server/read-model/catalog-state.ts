import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { TaskState } from "../../gen/a2a_pb.js";
import { ActivityState } from "../../gen/agentos/execution/v1/state_pb.js";
import {
  type TaskActivity,
  TaskActivityFilterSchema,
  TaskCatalogScopeSchema,
} from "../../gen/kagent/api/v1/task_catalog_pb.js";
import { taskActivity } from "./state.js";

export interface Viewer {
  subject: string;
  administrator: boolean;
  systemOnly?: boolean;
}

export function catalogScope(namespace: string, viewer: Viewer) {
  if (viewer.systemOnly && !viewer.administrator)
    throw new ConnectError("Permission denied", Code.PermissionDenied);
  return create(TaskCatalogScopeSchema, {
    namespace,
    visibility: viewer.systemOnly
      ? { case: "otherInitiators", value: {} }
      : { case: "owned", value: {} },
  });
}

export function catalogState(activity?: TaskActivity, empty = false): ActivityState {
  if (activity?.state === undefined) {
    if (empty) return ActivityState.IDLE;
    throw new ConnectError("Native task activity unavailable", Code.FailedPrecondition);
  }
  return activity.pendingToolApproval
    ? ActivityState.AWAITING_APPROVAL
    : taskActivity(activity.state);
}

export function activityFilters(states: readonly ActivityState[]) {
  return [...new Set(states)]
    .sort((a, b) => a - b)
    .flatMap((state) => {
      const value = (state: TaskState, pendingToolApproval = false) =>
        create(TaskActivityFilterSchema, { state, pendingToolApproval });
      switch (state) {
        case ActivityState.AWAITING_APPROVAL:
          return [create(TaskActivityFilterSchema, { pendingToolApproval: true })];
        case ActivityState.AWAITING_INPUT:
          return [value(TaskState.INPUT_REQUIRED), value(TaskState.AUTH_REQUIRED)];
        case ActivityState.SUBMITTED:
          return [value(TaskState.SUBMITTED)];
        case ActivityState.WORKING:
          return [value(TaskState.WORKING)];
        case ActivityState.SUCCEEDED:
          return [value(TaskState.COMPLETED)];
        case ActivityState.FAILED:
          return [value(TaskState.FAILED)];
        case ActivityState.REJECTED:
          return [value(TaskState.REJECTED)];
        case ActivityState.CANCELED:
          return [value(TaskState.CANCELED)];
        case ActivityState.UNOBSERVED:
          return [value(TaskState.UNSPECIFIED)];
        default:
          return [];
      }
    });
}
