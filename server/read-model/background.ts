import { Code, ConnectError } from "@connectrpc/connect";
import type { TaskExecution } from "../../gen/kagent/api/v1/execution_pb.js";
import type { KagentClients } from "../kagent/clients.js";
import { pool } from "../kagent/clients.js";
import { type AgentInfo, type SessionInfo, systemRoles } from "./agents.js";
import type { TaskEntry } from "./entry.js";

/** Resolve foreground boundaries from native lineage, independently of task payloads. */
export function runBackground(
  clients: KagentClients,
  session: (id: string) => Promise<SessionInfo | undefined>,
  agents: () => Promise<AgentInfo[]>,
) {
  return async (entries: TaskEntry[]) => {
    if (!entries.length) return new Map<string, boolean>();
    const roles = new Map((await agents()).map((agent) => [agent.id, agent.role]));
    const executions = new Map<string, Promise<TaskExecution | undefined>>(
      entries.map((entry) => [entry.id, Promise.resolve(entry.execution)]),
    );
    const sessions = new Map<string, ReturnType<typeof session>>();
    const result = new Map<string, boolean>();
    await pool(entries, 4, async (entry) => {
      let current = entry.execution;
      let background = false;
      const seen = new Set<string>();
      while (current?.task) {
        if (seen.has(current.task.taskId)) {
          background = entry.execution?.background ?? false;
          break;
        }
        seen.add(current.task.taskId);
        background ||= current.background;
        const parent = current.parent;
        if (!parent) break;
        if (!sessions.has(parent.sessionId))
          sessions.set(parent.sessionId, session(parent.sessionId));
        const owner = await sessions.get(parent.sessionId);
        if (!owner || systemRoles.has(roles.get(owner.agentId) ?? "")) break;
        if (!executions.has(parent.taskId))
          executions.set(
            parent.taskId,
            clients.execution
              .getTaskExecution({ taskId: parent.taskId }, { timeoutMs: 10_000 })
              .then(({ execution }) => execution)
              .catch((error: unknown) => {
                if (error instanceof ConnectError && error.code === Code.NotFound) return undefined;
                throw error;
              }),
          );
        current = await executions.get(parent.taskId);
        if (!current) break;
        if (current.task?.taskId !== parent.taskId || current.task.sessionId !== parent.sessionId)
          throw new ConnectError("Native task relationship unavailable", Code.FailedPrecondition);
      }
      result.set(entry.id, background);
    });
    return result;
  };
}
