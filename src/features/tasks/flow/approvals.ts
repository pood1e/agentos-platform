import type { Interaction } from "../../../../gen/agentos/console/v1/task_pb.js";
import { millis } from "../../../lib/format.js";
import { awaiting } from "../../status/activity.js";
import type { FlowActivity, FlowConnection } from "./collaboration-flow.js";
import type { Link } from "./links.js";
import { type CollaborationStep, eventTime } from "./sequence.js";

interface Flow {
  activities: FlowActivity[];
  connections: FlowConnection[];
  constraints: { source: string; target: string }[];
}

/** Inserts the observed approval authority between a pause and its continuation. */
export function approvals(flow: Flow, interactions: Interaction[], reviews: CollaborationStep[]) {
  const { activities, connections, constraints } = flow;
  for (const interaction of [...interactions].sort(
    (a, b) => (millis(a.requestedAt) ?? Infinity) - (millis(b.requestedAt) ?? Infinity),
  )) {
    const requestedAt = millis(interaction.requestedAt);
    const answeredAt = millis(interaction.answeredAt);
    const pending = awaiting(interaction.state);
    const owner = activities.findLast(
      (activity) =>
        activity.taskId === interaction.taskId &&
        activity.kind !== "approval" &&
        activity.kind !== "review" &&
        (activity.startedAt === undefined || activity.startedAt <= (requestedAt ?? Infinity)),
    );
    if (!owner) continue;
    const reviewers = reviews.filter(
      ({ link }) =>
        link.sourceTaskId === interaction.taskId && link.requestId === interaction.requestId,
    );
    const authority: FlowActivity[] = reviewers.length
      ? reviewers.map((step) => ({
          id: step.link.id,
          agentId: step.link.target,
          taskId: step.link.targetTaskId ?? "",
          kind: "review",
          root: false,
          final: pending,
          returns: [],
          interaction,
          step,
          startedAt: step.link.startedAt,
          endedAt: eventTime(step.link, "finished"),
        }))
      : [
          {
            id: interaction.id,
            agentId: interaction.agentId,
            taskId: interaction.taskId,
            kind: "approval",
            root: false,
            final: pending,
            returns: [],
            interaction,
            startedAt: requestedAt,
            endedAt: answeredAt,
          },
        ];
    const outgoing = connections.filter(
      (connection) =>
        connection.source === owner.id &&
        (connection.phase === "return" ||
          connection.link.kind === "resume" ||
          (requestedAt !== undefined && (connection.link.startedAt ?? 0) >= requestedAt)),
    );
    const link: Link = {
      id: interaction.id,
      source: interaction.agentId,
      target: "human",
      kind: "approval",
      sourceTaskId: interaction.taskId,
      startedAt: requestedAt,
      state: interaction.state,
    };
    activities.push(...authority);
    for (const node of authority) {
      connections.push({
        id: `${node.id}:request`,
        source: owner.id,
        target: node.id,
        phase: "approval",
        link: node.step?.link ?? link,
      });
      for (const earlier of authority) {
        if (
          earlier.endedAt !== undefined &&
          node.startedAt !== undefined &&
          earlier.startedAt !== undefined &&
          earlier.startedAt < node.startedAt &&
          earlier.endedAt <= node.startedAt
        )
          constraints.push({ source: earlier.id, target: node.id });
      }
    }
    if (pending) continue;
    const continued: FlowActivity = {
      ...owner,
      id: `${interaction.id}:continued`,
      kind: "continued",
      interaction: undefined,
      startedAt: answeredAt,
      final: owner.final,
    };
    activities.push(continued);
    owner.final = false;
    for (const node of authority)
      connections.push({
        id: `${node.id}:decision`,
        source: node.id,
        target: continued.id,
        phase: "approval",
        link: node.step ? { ...node.step.link, state: interaction.state } : link,
      });
    for (const connection of outgoing) connection.source = continued.id;
  }
}
