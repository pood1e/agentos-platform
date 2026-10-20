import type { ActivityState } from "../../../gen/agentos/console/v1/state_pb.js";
import { InteractionKind, type TaskDetail } from "../../../gen/agentos/console/v1/task_pb.js";
import { millis } from "../../lib/format.js";
import { active, awaiting } from "../status/activity.js";
import type { DrawerTarget } from "./AgentDrawer.js";

export interface TimelineInterval {
  id: string;
  kind: "execution" | "delegation" | "approval";
  agentId: string;
  state: ActivityState;
  startedAt?: number;
  endedAt?: number;
  open: boolean;
  background: boolean;
  target: DrawerTarget;
}

export function timelineIntervals(detail: TaskDetail): TimelineInterval[] {
  const intervals: TimelineInterval[] = [
    ...detail.runs.map(
      (run): TimelineInterval => ({
        id: `run:${run.taskId}`,
        kind: "execution",
        agentId: run.agentId,
        state: run.state,
        startedAt: millis(run.startedAt),
        endedAt: active(run.state) || awaiting(run.state) ? undefined : millis(run.updatedAt),
        open: active(run.state) || awaiting(run.state),
        background: run.background,
        target: { taskId: run.taskId, contextId: run.contextId },
      }),
    ),
    ...detail.delegations.map(
      (link): TimelineInterval => ({
        id: link.id,
        kind: "delegation",
        agentId: link.sourceAgentId,
        state: link.state,
        startedAt: millis(link.startedAt),
        endedAt: millis(link.returnedAt ?? link.finishedAt),
        open:
          !link.returned &&
          !link.returnedAt &&
          !link.finishedAt &&
          (active(link.state) || awaiting(link.state)),
        background: false,
        target: link.callId
          ? {
              taskId: link.sourceTaskId,
              contextId: link.sourceContextId,
              callKey: `${link.sourceTaskId}:${link.callId}`,
            }
          : { taskId: link.targetTaskId, contextId: link.targetContextId },
      }),
    ),
    ...detail.interactions
      .filter((item) => item.kind === InteractionKind.APPROVAL)
      .map(
        (item): TimelineInterval => ({
          id: item.id,
          kind: "approval",
          agentId: item.agentId,
          state: item.state,
          startedAt: millis(item.requestedAt),
          endedAt: millis(item.answeredAt),
          open: awaiting(item.state),
          background: detail.runs.some((run) => run.taskId === item.taskId && run.background),
          target: { interactionId: item.id },
        }),
      ),
  ];
  return intervals.sort(
    (a, b) => (a.startedAt ?? Infinity) - (b.startedAt ?? Infinity) || a.id.localeCompare(b.id),
  );
}
