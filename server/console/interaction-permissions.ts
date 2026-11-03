import { type Interaction, InteractionKind } from "../../gen/agentos/console/v1/task_pb.js";
import { ActivityState } from "../../gen/agentos/execution/v1/state_pb.js";
import type { KagentClients } from "../kagent/clients.js";
import type { TaskQueries } from "../read-model/queries.js";

/** Display permissions follow native authority; native A2A rechecks mutations. */
export function interactionPermissions(
  projection: Pick<TaskQueries, "entry">,
  clients: KagentClients,
) {
  const canOperate = async (contextId: string, subject: string) => {
    try {
      const result = await clients.execution.getSessionAuthority({ sessionId: contextId });
      return !result.revoked && result.authority?.initiatorId === subject;
    } catch {
      return false;
    }
  };
  const canApprove = async (interaction: Interaction, subject: string) => {
    if (
      interaction.kind !== InteractionKind.APPROVAL ||
      interaction.state !== ActivityState.AWAITING_APPROVAL
    )
      return false;
    try {
      const entry = await projection.entry(interaction.taskId);
      return !!entry && (await canOperate(entry.contextId, subject));
    } catch {
      return false;
    }
  };
  const approvalsFor = async (interactions: Interaction[], subject: string, operate: boolean) => {
    for (const interaction of interactions)
      interaction.approve = operate && (await canApprove(interaction, subject));
  };
  return { canOperate, approvalsFor };
}
