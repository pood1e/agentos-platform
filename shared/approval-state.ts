import type { Interaction } from "../gen/agentos/console/v1/task_pb.js";
import { ActivityState } from "../gen/agentos/execution/v1/state_pb.js";
import type { Approval } from "../gen/agentos/governance/v1/governance_pb.js";

/** Human approval can be complete while native execution is still waiting to resume. */
export function approvalInteractionState(interaction: Interaction, records: Approval[]) {
  if (
    !interaction.external ||
    interaction.state !== ActivityState.AWAITING_APPROVAL ||
    !interaction.tools.length ||
    !interaction.tools.every((tool) =>
      records.some(
        (record) =>
          record.reference?.toolId === tool.id &&
          record.reference.taskId === interaction.taskId &&
          [ActivityState.SUCCEEDED, ActivityState.WORKING].includes(record.state),
      ),
    )
  )
    return interaction.state;
  return ActivityState.SUCCEEDED;
}
