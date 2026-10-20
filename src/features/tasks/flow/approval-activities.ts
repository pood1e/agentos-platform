import { type Interaction, InteractionKind } from "../../../../gen/agentos/console/v1/task_pb.js";
import type { Change } from "../../../../gen/agentos/governance/v1/change_pb.js";
import { ticketIdentity } from "../../shared/ticket-identity.js";
import { awaiting } from "../../status/activity.js";

export const ticketNodeId = (change: Change) => {
  const identity = ticketIdentity(change);
  return identity ? `ticket:${identity}` : undefined;
};

export function approvalActivities(interaction: Interaction) {
  const tickets = new Map<string, { id: string; ticket: Change }>();
  if (interaction.kind === InteractionKind.APPROVAL)
    for (const change of interaction.changes) {
      const id = ticketNodeId(change);
      if (id) tickets.set(id, { id, ticket: change });
    }
  return tickets.size
    ? [...tickets.values()]
    : [{ id: `interaction:${interaction.id}`, ticket: undefined }];
}

export const currentInteraction = (interactions: Interaction[]) =>
  interactions.findLast((item) => awaiting(item.state)) ?? interactions.at(-1);
