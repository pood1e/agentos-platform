import { type Interaction, InteractionKind } from "../../../gen/agentos/console/v1/task_pb.js";
import { ActivityState } from "../../../gen/agentos/execution/v1/state_pb.js";
import { awaiting } from "../status/activity.js";

export function interactionLabel(interaction: Interaction) {
  const approval = interaction.kind === InteractionKind.APPROVAL;
  if (awaiting(interaction.state)) return approval ? "approval.pending" : "activity.awaitingInput";
  if (interaction.state === ActivityState.CANCELED) return "activity.canceled";
  if (interaction.state === ActivityState.FAILED)
    return approval ? "approval.validationFailed" : "activity.failed";
  if (!approval) return "approval.answered";
  return interaction.state === ActivityState.REJECTED
    ? "approval.notApproved"
    : "approval.approved";
}
