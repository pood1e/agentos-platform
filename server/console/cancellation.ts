import type { ExecutionIdentity } from "../../gen/agentos/execution/v1/identity_pb.js";
import { type Executions, relatedExecutions } from "../authorization/executions.js";
import type { KagentClients } from "../kagent/clients.js";
import { cancelTree } from "../read-model/cancel.js";
import { terminal } from "../read-model/state.js";
import type { KagentSync } from "../read-model/sync.js";
import { taskTree } from "../read-model/tree.js";
import { notFound } from "../shared/errors.js";
import { exclusiveCommands } from "../shared/exclusive.js";
import { executionHistory } from "./history.js";

export function cancellationCommands(
  sync: KagentSync,
  clients: KagentClients,
  executions?: Executions,
  exclusive = exclusiveCommands(),
) {
  const history = executionHistory(sync.index, executions);
  async function treeFor(taskId: string, identity: ExecutionIdentity) {
    const visible = await history(identity);
    const root = visible.operationRoot(taskId);
    const tree = root && taskTree(visible, root.id);
    if (!tree) throw notFound("task.notFound");
    const entries = new Map(
      visible
        .contextEntries(tree.root.contextId)
        .flatMap((entry) =>
          (taskTree(visible, entry.id)?.entries ?? []).map(
            (member) => [member.id, member] as const,
          ),
        ),
    );
    return { root: tree.root, entries: [...entries.values()] };
  }

  return async (taskId: string, identity: ExecutionIdentity, signal: AbortSignal) => {
    const initial = await treeFor(taskId, identity);
    return exclusive(initial.root.contextId, async () => {
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
      do {
        deadline.throwIfAborted();
        await sync.refresh();
        const tree = await treeFor(initial.root.id, identity);
        if (executions) {
          const { session } = await clients.sessions.getSession(
            { sessionId: tree.root.contextId },
            { signal: deadline },
          );
          if (!session) throw notFound("task.notFound");
          await executions.own(session, identity);
          await relatedExecutions(
            executions,
            clients.sessions,
            session,
            tree.entries.map((entry) => entry.contextId),
          );
        }
        await cancelTree(clients, sync, tree, deadline);
        // A worker accepted during cancellation can appear after the initial task listing.
        await sync.refresh();
      } while (
        (await treeFor(initial.root.id, identity)).entries.some((entry) => !terminal(entry.state))
      );
    });
  };
}
