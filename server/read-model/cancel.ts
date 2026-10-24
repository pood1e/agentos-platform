import { Code, ConnectError } from "@connectrpc/connect";
import type { KagentClients } from "../kagent/clients.js";
import { ingest } from "./entry.js";
import { terminal } from "./state.js";
import type { KagentSync } from "./sync.js";
import type { TaskTree } from "./tree.js";

/** Cancel every unfinished delegated task, preserving successful results on partial failure. */
export async function cancelTree(
  clients: Pick<KagentClients, "a2a">,
  sync: KagentSync,
  tree: Pick<TaskTree, "entries">,
  signal?: AbortSignal,
): Promise<void> {
  const results = await Promise.allSettled(
    tree.entries
      .filter((entry) => !terminal(entry.state))
      .map(async (entry) => {
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
        sync.index.upsert(ingest(task, entry.agentId));
        if (!terminal(task.status?.state))
          throw new ConnectError("Task cancellation is still pending", Code.FailedPrecondition);
      }),
  );
  sync.index.flush();
  const failure = results.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
}
