import { type Interaction, InteractionKind } from "../../gen/agentos/console/v1/task_pb.js";
import { ActivityState } from "../../gen/agentos/execution/v1/state_pb.js";
import type { GovernanceConfig } from "../../gen/agentos/governance/v1/governance_pb.js";
import type { Session } from "../../gen/kagent/api/v1/sessions_pb.js";
import type { Executions } from "../authorization/executions.js";
import { approvalEnvironment } from "../governance/client.js";
import type { KagentClients } from "../kagent/clients.js";
import type { TaskIndex } from "../read-model/index.js";

export type AuthorizeTools = (session: Session, tools: string[]) => Promise<void>;

/** Readable history is independent from current execution and approval authority. */
export function interactionPermissions(
  index: TaskIndex,
  clients: KagentClients,
  operations: GovernanceConfig,
  executions?: Executions,
  authorizeTools?: AuthorizeTools,
) {
  const canOperate = async (contextId: string, subject: string) => {
    if (!executions) return true;
    try {
      const { session } = await clients.sessions.getSession({ sessionId: contextId });
      if (!session) return false;
      return (await executions.resolve(session)).binding.subject === subject;
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
        interaction.state !== ActivityState.AWAITING_APPROVAL ||
        interaction.tools.some(
          (tool) => approvalEnvironment(operations.environments, tool.name)?.approvalUrl,
        )
      )
        continue;
      try {
        const entry = index.entry(interaction.taskId);
        if (!entry || !(await canOperate(entry.contextId, subject))) continue;
        const { session } = await clients.sessions.getSession({ sessionId: entry.contextId });
        if (authorizeTools) {
          if (!session) continue;
          await authorizeTools(
            session,
            interaction.tools.map((tool) => tool.name),
          );
        }
        interaction.approve = true;
      } catch {
        // A failed permission check preserves readable history.
      }
    }
  };
  return { canOperate, approvalsFor };
}
