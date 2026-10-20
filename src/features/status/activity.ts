import { ActivityState } from "../../../gen/agentos/execution/v1/state_pb.js";

export type Tone = "working" | "waiting" | "succeeded" | "failed" | "neutral" | "unavailable";

const activities: Record<ActivityState, { tone: Tone; label: string }> = {
  [ActivityState.UNSPECIFIED]: { tone: "neutral", label: "activity.unobserved" },
  [ActivityState.SUBMITTED]: { tone: "neutral", label: "activity.submitted" },
  [ActivityState.WORKING]: { tone: "working", label: "activity.working" },
  [ActivityState.AWAITING_APPROVAL]: { tone: "waiting", label: "activity.awaitingApproval" },
  [ActivityState.AWAITING_INPUT]: { tone: "waiting", label: "activity.awaitingInput" },
  [ActivityState.SUCCEEDED]: { tone: "succeeded", label: "activity.succeeded" },
  [ActivityState.FAILED]: { tone: "failed", label: "activity.failed" },
  [ActivityState.REJECTED]: { tone: "failed", label: "activity.rejected" },
  [ActivityState.CANCELED]: { tone: "neutral", label: "activity.canceled" },
  [ActivityState.IDLE]: { tone: "neutral", label: "activity.idle" },
  [ActivityState.UNAVAILABLE]: { tone: "unavailable", label: "activity.unavailable" },
  [ActivityState.UNOBSERVED]: { tone: "neutral", label: "activity.unobserved" },
};

const activity = (state: ActivityState) =>
  activities[state] ?? activities[ActivityState.UNOBSERVED];
export const toneOf = (state: ActivityState) => activity(state).tone;
export const labelKey = (state: ActivityState) => activity(state).label;

export const active = (state: ActivityState) =>
  state === ActivityState.WORKING || state === ActivityState.SUBMITTED;
export const awaiting = (state: ActivityState) =>
  state === ActivityState.AWAITING_APPROVAL || state === ActivityState.AWAITING_INPUT;

/** Avatar posture for an engineer's activity. */
export const posture = (state: ActivityState) =>
  active(state) ? "working" : awaiting(state) ? "waiting" : "idle";
