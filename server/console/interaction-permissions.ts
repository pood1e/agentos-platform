import { type Interaction, InteractionKind } from "../../gen/agentos/console/v1/task_pb.js";
import { ActivityState } from "../../gen/agentos/execution/v1/state_pb.js";
import type { KagentClients } from "../kagent/clients.js";
import type { TaskGraph } from "../read-model/graph.js";

/** Display permissions follow native authority; native A2A rechecks mutations. */
export function interactionPermissions(clients: KagentClients) {
  const canOperate = async (contextId: string, subject: string) => {
    try {
      const result = await clients.execution.getSessionAuthority({ sessionId: contextId });
      return !result.revoked && result.authority?.initiatorId === subject;
    } catch {
      return false;
    }
  };
  /** Interactions come from the graph, so its entries already name their authorized Sessions. */
  const approvalsFor = async (
    interactions: Interaction[],
    graph: TaskGraph,
    subject: string,
    operate: boolean,
  ) => {
    const sessions = new Map<string, Promise<boolean>>();
    for (const interaction of interactions) {
      const contextId = graph.entry(interaction.taskId)?.contextId;
      if (
        !operate ||
        !contextId ||
        interaction.kind !== InteractionKind.APPROVAL ||
        interaction.state !== ActivityState.AWAITING_APPROVAL
      ) {
        interaction.approve = false;
        continue;
      }
      if (!sessions.has(contextId)) sessions.set(contextId, canOperate(contextId, subject));
      interaction.approve = (await sessions.get(contextId)) === true;
    }
  };
  return { canOperate, approvalsFor };
}
