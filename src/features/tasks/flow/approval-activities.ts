import { type Interaction, InteractionKind } from "../../../../gen/agentos/console/v1/task_pb.js";
import type { Approval } from "../../../../gen/agentos/governance/v1/governance_pb.js";
import { approvalIdentity } from "../../shared/approval-identity.js";
import { awaiting } from "../../status/activity.js";

export const approvalNodeId = (change: Approval) => {
  const identity = approvalIdentity(change);
  return identity ? `record:${identity}` : undefined;
};

export function approvalActivities(interaction: Interaction) {
  const tickets = new Map<string, { id: string; record: Approval }>();
  if (interaction.kind === InteractionKind.APPROVAL)
    for (const change of interaction.approvals) {
      const id = approvalNodeId(change);
      if (id) tickets.set(id, { id, record: change });
    }
  return tickets.size
    ? [...tickets.values()]
    : [{ id: `interaction:${interaction.id}`, record: undefined }];
}

export const currentInteraction = (interactions: Interaction[]) =>
  interactions.findLast((item) => awaiting(item.state)) ?? interactions.at(-1);
