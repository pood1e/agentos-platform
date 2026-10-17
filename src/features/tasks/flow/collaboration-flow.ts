import { ActivityState } from "../../../../gen/agentos/console/v1/state_pb.js";
import type { Interaction, TaskDetail } from "../../../../gen/agentos/console/v1/task_pb.js";
import type { Change } from "../../../../gen/agentos/governance/v1/change_pb.js";
import { millis } from "../../../lib/format.js";
import { active, awaiting } from "../../status/activity.js";
import { approvalActivities, currentInteraction } from "./approval-activities.js";
import { delegationRanks } from "./delegation-ranks.js";
import { type Link, linksOf } from "./links.js";
import { type CollaborationStep, sequenceFor } from "./sequence.js";

export interface FlowActivity {
  id: string;
  contextId: string;
  agentId: string;
  name: string;
  taskId: string;
  taskIds: string[];
  kind: "engineer" | "approval";
  root: boolean;
  rank: number;
  state: ActivityState;
  interactions: Interaction[];
  ticket?: Change;
}

export interface FlowConnection {
  id: string;
  source: string;
  target: string;
  phase: "dispatch" | "return" | "approval";
  step: CollaborationStep;
}

export const instanceNodeId = (contextId: string) => `session:${contextId}`;

/** Current work takes precedence over previous completed attempts. */
export function currentState(states: ActivityState[]) {
  return (
    states.find((state) => state === ActivityState.WORKING) ??
    states.find(active) ??
    states.find(awaiting) ??
    states.at(-1) ??
    ActivityState.UNOBSERVED
  );
}

/** Native Sessions are instances; Tasks are executions inside their existing context. */
export function collaborationFlow(detail: TaskDetail) {
  const steps = sequenceFor(linksOf(detail));
  const ranks = delegationRanks(steps, detail.summary?.id);
  const rootRun = detail.runs.find((run) => run.taskId === detail.summary?.id);
  const activities = new Map<string, FlowActivity>();
  const connections = new Map<string, FlowConnection>();
  const addInstance = (contextId: string, agentId: string, taskId: string, rank: number) => {
    if (!contextId) return;
    const id = instanceNodeId(contextId);
    const known = activities.get(id);
    if (known) {
      known.rank = Math.min(known.rank, rank);
      if (taskId && !known.taskIds.includes(taskId)) known.taskIds.push(taskId);
      return known;
    }
    const activity: FlowActivity = {
      id,
      contextId,
      agentId,
      taskId,
      name: detail.sessions.find((session) => session.id === contextId)?.name ?? "",
      taskIds: taskId ? [taskId] : [],
      kind: "engineer",
      root: contextId === rootRun?.contextId,
      rank,
      state: ActivityState.UNOBSERVED,
      interactions: [],
    };
    activities.set(id, activity);
    return activity;
  };
  const connect = (
    source: string,
    target: string,
    step: CollaborationStep,
    phase: FlowConnection["phase"],
  ) => {
    const id = JSON.stringify([source, target, phase, step.link.id]);
    connections.set(id, { id, source, target, phase, step });
  };
  if (rootRun) addInstance(rootRun.contextId, rootRun.agentId, rootRun.taskId, 0);
  for (const step of steps) {
    const { link } = step;
    const rank = ranks.get(link.id) ?? 1;
    const source = addInstance(
      link.sourceContextId,
      link.source,
      link.sourceTaskId,
      Math.max(0, rank - 1),
    );
    const target = addInstance(link.targetContextId, link.target, link.targetTaskId ?? "", rank);
    if (!source || !target) continue;
    connect(source.id, target.id, step, "dispatch");
    if (link.kind === "invoke" && link.returned) connect(target.id, source.id, step, "return");
  }
  for (const interaction of [...detail.interactions].sort(
    (a, b) =>
      (millis(a.requestedAt) ?? 0) - (millis(b.requestedAt) ?? 0) || a.id.localeCompare(b.id),
  )) {
    const contextId = detail.runs.find((run) => run.taskId === interaction.taskId)?.contextId;
    const owner = contextId && activities.get(instanceNodeId(contextId));
    if (!owner) continue;
    const reviewers = steps.filter(
      ({ link }) =>
        link.kind === "review" &&
        link.sourceTaskId === interaction.taskId &&
        link.requestId === interaction.requestId,
    );
    const link: Link = {
      id: interaction.id,
      source: interaction.agentId,
      target: "human",
      sourceTaskId: interaction.taskId,
      sourceContextId: owner.contextId,
      targetContextId: "",
      kind: "approval",
      state: interaction.state,
      startedAt: millis(interaction.requestedAt),
      endedAt: millis(interaction.answeredAt),
      returned: !awaiting(interaction.state),
      dependsOn: [],
    };
    const step: CollaborationStep = { link, occurrence: 1, simultaneous: [], parallel: [] };
    const authorities = reviewers.flatMap(
      ({ link }) => activities.get(instanceNodeId(link.targetContextId)) ?? [],
    );
    const rank = Math.max(owner.rank, ...authorities.map((item) => item.rank)) + 1;
    for (const { id, ticket } of approvalActivities(interaction)) {
      const known = activities.get(id);
      const approvals = [...(known?.interactions ?? []), interaction];
      const current = currentInteraction(approvals) ?? interaction;
      activities.set(id, {
        id,
        contextId: "",
        agentId: current.agentId,
        name: "",
        taskId: current.taskId,
        taskIds: [...new Set(approvals.map((item) => item.taskId))],
        kind: "approval",
        interactions: approvals,
        ticket,
        root: false,
        rank: Math.min(known?.rank ?? rank, rank),
        state: current.state,
      });
      for (const authority of authorities.length ? authorities : [owner])
        connect(authority.id, id, step, "approval");
      if ([ActivityState.SUCCEEDED, ActivityState.REJECTED].includes(interaction.state))
        connect(id, owner.id, step, "return");
    }
  }
  for (const activity of activities.values()) {
    if (activity.kind === "approval") continue;
    const executions = detail.runs
      .filter((run) => run.contextId === activity.contextId)
      .sort(
        (a, b) =>
          (millis(a.updatedAt) ?? 0) - (millis(b.updatedAt) ?? 0) ||
          a.taskId.localeCompare(b.taskId),
      );
    const current =
      executions.findLast((run) => active(run.state)) ??
      executions.findLast((run) => awaiting(run.state)) ??
      executions.at(-1);
    if (current) activity.taskId = current.taskId;
    activity.taskIds = [...new Set([...activity.taskIds, ...executions.map((run) => run.taskId)])];
    activity.state = currentState(
      executions.length
        ? executions.map((run) => run.state)
        : steps
            .filter(({ link }) => link.targetContextId === activity.contextId)
            .map(({ link }) => link.state),
    );
  }
  return { activities: [...activities.values()], connections: [...connections.values()], steps };
}

export type CollaborationFlow = ReturnType<typeof collaborationFlow>;
