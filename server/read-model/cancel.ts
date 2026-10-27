import { Code, ConnectError } from "@connectrpc/connect";
import { Mutex } from "async-mutex";
import type { KagentClients } from "../kagent/clients.js";
import type { Native, TaskProjection } from "./projection.js";
import { terminal } from "./state.js";
import type { TaskTree } from "./tree.js";

/** Cancel every unfinished delegated task, preserving successful results on partial failure. */
export async function cancelTree(
  clients: Pick<KagentClients, "a2a">,
  projection: Pick<TaskProjection, "apply">,
  tree: Pick<TaskTree, "entries">,
  signal?: AbortSignal,
): Promise<void> {
  const sessions = new Map<string, Mutex>();
  const canceled: Native[] = [];
  const results = await Promise.allSettled(
    tree.entries
      .filter((entry) => !terminal(entry.state))
      .map((entry) => {
        let session = sessions.get(entry.contextId);
        if (!session) {
          session = new Mutex();
          sessions.set(entry.contextId, session);
        }
        // Tasks in a native session share one runtime actor.
        return session.runExclusive(async () => {
          signal?.throwIfAborted();
          const request = { tenant: entry.agentId, id: entry.id };
          const options = { timeoutMs: 30_000, signal };
          const task = await clients.a2a
            .cancelTask(request, options)
            .catch(async (error: unknown) => {
              if (ConnectError.from(error).code !== Code.FailedPrecondition) throw error;
              const current = await clients.a2a.getTask(request, options);
              if (!terminal(current.status?.state)) throw error;
              return current;
            });
          canceled.push({ task, agentId: entry.agentId });
          if (!terminal(task.status?.state))
            throw new ConnectError("Task cancellation is still pending", Code.FailedPrecondition);
        });
      }),
  );
  await projection.apply(canceled);
  const failure = results.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
}
