import { type Interaction, InteractionKind } from "../../../../gen/agentos/console/v1/task_pb.js";
import type { Approval } from "../../../../gen/agentos/governance/v1/governance_pb.js";
import { approvalIdentity } from "../../shared/approval-identity.js";
import { awaiting } from "../../status/activity.js";

export const approvalNodeId = (approval: Approval) => {
  const identity = approvalIdentity(approval);
  return identity ? `record:${identity}` : undefined;
};

export function approvalActivities(interaction: Interaction) {
  const records = new Map<string, { id: string; record: Approval }>();
  if (interaction.kind === InteractionKind.APPROVAL)
    for (const approval of interaction.approvals) {
      const id = approvalNodeId(approval);
      if (id) records.set(id, { id, record: approval });
    }
  return records.size
    ? [...records.values()]
    : [{ id: `interaction:${interaction.id}`, record: undefined }];
}

export const currentInteraction = (interactions: Interaction[]) =>
  interactions.findLast((item) => awaiting(item.state)) ?? interactions.at(-1);
