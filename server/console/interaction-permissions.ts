import { type Interaction, InteractionKind } from "../../gen/agentos/console/v1/task_pb.js";
import { ActivityState } from "../../gen/agentos/execution/v1/state_pb.js";
import type { Session } from "../../gen/kagent/api/v1/sessions_pb.js";
import type { KagentClients } from "../kagent/clients.js";
import type { TaskQueries } from "../read-model/queries.js";
export type AuthorizeTools = (session: Session, tools: string[]) => Promise<void>;

/** Display permissions follow native authority; native A2A rechecks mutations. */
export function interactionPermissions(
  projection: Pick<TaskQueries, "entry">,
  clients: KagentClients,
  authorizeTools?: AuthorizeTools,
) {
  const canOperate = async (contextId: string, subject: string) => {
    try {
      const result = await clients.execution.getSessionAuthority({ sessionId: contextId });
      return !result.revoked && result.authority?.initiatorId === subject;
    } catch {
      return false;
    }
  };
  const approvalsFor = async (interactions: Interaction[], subject: string, operate: boolean) => {
    for (const interaction of interactions) {
      interaction.approve = false;
      if (
        !operate ||
        interaction.kind !== InteractionKind.APPROVAL ||
        interaction.state !== ActivityState.AWAITING_APPROVAL
      )
        continue;
      try {
        const entry = await projection.entry(interaction.taskId);
        if (!entry || !(await canOperate(entry.contextId, subject))) continue;
        if (authorizeTools) {
          const { session } = await clients.sessions.getSession({ sessionId: entry.contextId });
          if (!session) continue;
          await authorizeTools(
            session,
            interaction.tools.map((tool) => tool.name),
          );
        }
        interaction.approve = true;
      } catch {}
    }
  };
  return { canOperate, approvalsFor };
}
