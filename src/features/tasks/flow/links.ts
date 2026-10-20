import { DelegationKind, type TaskDetail } from "../../../../gen/agentos/console/v1/task_pb.js";
import { ActivityState } from "../../../../gen/agentos/execution/v1/state_pb.js";
import { millis } from "../../../lib/format.js";

export type LinkKind = "invoke" | "background" | "handoff" | "resume" | "approval" | "review";

/** One observed hand-over between participants, in milliseconds. */
export interface Link {
  id: string;
  source: string;
  target: string;
  kind: LinkKind;
  state: ActivityState;
  sourceTaskId: string;
  sourceContextId: string;
  targetContextId: string;
  targetTaskId?: string;
  callKey?: string;
  requestId?: string;
  startedAt?: number;
  endedAt?: number;
  finishedAt?: number;
  dependsOn: string[];
  returned: boolean;
}

const kinds: Record<DelegationKind, LinkKind> = {
  [DelegationKind.UNSPECIFIED]: "invoke",
  [DelegationKind.INVOKE]: "invoke",
  [DelegationKind.BACKGROUND]: "background",
  [DelegationKind.HANDOFF]: "handoff",
  [DelegationKind.RESUME]: "resume",
  [DelegationKind.REVIEW]: "review",
};

export const callKey = (taskId: string, callId: string) => `${taskId}:${callId}`;

export function linksOf(detail: TaskDetail): Link[] {
  return detail.delegations.map((delegation) => ({
    id: delegation.id,
    source: delegation.sourceAgentId,
    target: delegation.targetAgentId,
    kind: kinds[delegation.kind],
    state: delegation.state,
    sourceTaskId: delegation.sourceTaskId,
    sourceContextId: delegation.sourceContextId,
    targetContextId: delegation.targetContextId,
    targetTaskId: delegation.targetTaskId || undefined,
    callKey: delegation.callId ? callKey(delegation.sourceTaskId, delegation.callId) : undefined,
    requestId: delegation.requestId || undefined,
    startedAt: millis(delegation.startedAt),
    endedAt: millis(delegation.returnedAt),
    finishedAt: millis(delegation.finishedAt),
    dependsOn: delegation.dependsOn,
    returned: delegation.returned,
  }));
}

export const running = (state: ActivityState) =>
  state === ActivityState.WORKING || state === ActivityState.SUBMITTED;
