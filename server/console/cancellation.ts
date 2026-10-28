import type { ExecutionIdentity } from "../../gen/agentos/execution/v1/identity_pb.js";
import { type Executions, relatedExecutions } from "../authorization/executions.js";
import type { KagentClients } from "../kagent/clients.js";
import { cancelTree } from "../read-model/cancel.js";
import type { TaskProjection } from "../read-model/projection.js";
import { refreshContexts } from "../read-model/reconcile.js";
import { terminal } from "../read-model/state.js";
import { taskTree } from "../read-model/tree.js";
import { notFound } from "../shared/errors.js";
import { viewer, visibleGraph } from "./history.js";

export function cancellationCommands(
  projection: TaskProjection,
  clients: KagentClients,
  executions: Executions,
) {
  async function treeFor(taskId: string, identity: ExecutionIdentity) {
    const graph = await visibleGraph(projection, viewer(identity), { taskId });
    const root = graph?.operationRoot(taskId);
    const tree = graph && root && taskTree(graph, root.id);
    if (!graph || !tree) throw notFound("task.notFound");
    const entries = new Map(
      graph
        .contextEntries(tree.root.contextId)
        .flatMap((entry) =>
          (taskTree(graph, entry.id)?.entries ?? []).map((member) => [member.id, member] as const),
        ),
    );
    return { root: tree.root, entries: [...entries.values()] };
  }
  // A worker accepted during cancellation can appear after the last projected state.
  const refresh = (tree: Awaited<ReturnType<typeof treeFor>>, signal: AbortSignal) =>
    refreshContexts(
      projection,
      clients,
      [...new Map(tree.entries.map((entry) => [entry.contextId, entry.agentId])).entries()].map(
        ([id, agentId]) => ({ id, agentId }),
      ),
      signal,
    );

  return async (taskId: string, identity: ExecutionIdentity, signal: AbortSignal) => {
    const initial = await treeFor(taskId, identity);
    return projection.exclusive(initial.root.contextId, async () => {
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
      await refresh(initial, deadline);
      for (;;) {
        deadline.throwIfAborted();
        const tree = await treeFor(initial.root.id, identity);
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
        if (tree.entries.every((entry) => terminal(entry.state))) return;
        await cancelTree(clients, projection, tree, deadline);
        await refresh(tree, deadline);
      }
    });
  };
}
