import type { UserIdentity } from "../../gen/agentos/authorization/v1/identity_pb.js";
import type { KagentClients } from "../kagent/clients.js";
import type { TaskQueries } from "../read-model/queries.js";
import { notFound } from "../shared/errors.js";
import { viewer, visibleGraph } from "./history.js";

/** One native cancellation persists the fence and propagates through delegated work. */
export function cancellationCommands(projection: TaskQueries, clients: KagentClients) {
  return async (taskId: string, identity: UserIdentity, signal: AbortSignal) => {
    const graph = await visibleGraph(projection, viewer(identity), { taskId });
    const root = graph?.operationRoot(taskId);
    if (!root) throw notFound("task.notFound");
    await clients.a2a.cancelTask(
      { id: root.id, tenant: root.agentId },
      { signal, timeoutMs: 30_000 },
    );
  };
}
