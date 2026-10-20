import { TaskState } from "../../gen/a2a_pb.js";
import { ActivityState } from "../../gen/agentos/execution/v1/state_pb.js";

export const terminal = (state?: TaskState) =>
  state === TaskState.COMPLETED ||
  state === TaskState.FAILED ||
  state === TaskState.CANCELED ||
  state === TaskState.REJECTED;

export const interrupted = (state?: TaskState) =>
  state === TaskState.INPUT_REQUIRED || state === TaskState.AUTH_REQUIRED;

export function taskActivity(state?: TaskState): ActivityState {
  switch (state) {
    case TaskState.SUBMITTED:
      return ActivityState.SUBMITTED;
    case TaskState.WORKING:
      return ActivityState.WORKING;
    case TaskState.INPUT_REQUIRED:
    case TaskState.AUTH_REQUIRED:
      return ActivityState.AWAITING_INPUT;
    case TaskState.COMPLETED:
      return ActivityState.SUCCEEDED;
    case TaskState.FAILED:
      return ActivityState.FAILED;
    case TaskState.CANCELED:
      return ActivityState.CANCELED;
    case TaskState.REJECTED:
      return ActivityState.REJECTED;
    default:
      return ActivityState.UNOBSERVED;
  }
}

export const awaiting = (state: ActivityState) =>
  state === ActivityState.AWAITING_APPROVAL || state === ActivityState.AWAITING_INPUT;
