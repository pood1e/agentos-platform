import { Code, ConnectError } from "@connectrpc/connect";
import type { Session } from "../../gen/kagent/api/v1/sessions_pb.js";
import type { CatalogTask } from "../../gen/kagent/api/v1/task_catalog_pb.js";
import { type AgentInfo, agentKey, sessionInfo } from "./agents.js";
import { ingest } from "./entry.js";
import { TaskGraph } from "./graph.js";

export interface CatalogRows {
  tasks: CatalogTask[];
  sessions: Session[];
}

export function catalogGraph(namespace: string, rows: CatalogRows, agents: AgentInfo[]) {
  if (
    rows.sessions.some(
      (session) => !session.id || !session.agent?.name || session.agent.namespace !== namespace,
    )
  )
    throw new ConnectError("Native session catalog unavailable", Code.FailedPrecondition);
  const sessions = new Map(rows.sessions.map((session) => [session.id, session]));
  const entries = rows.tasks.map(({ task, execution, initialPrompt }) => {
    const session = task && sessions.get(task.contextId);
    if (
      !task?.id ||
      !session?.agent?.name ||
      session.agent.namespace !== namespace ||
      execution?.task?.taskId !== task.id ||
      execution.task.sessionId !== task.contextId
    )
      throw new ConnectError("Native task relationship unavailable", Code.FailedPrecondition);
    return { ...ingest(task, agentKey(session.agent), execution), prompt: initialPrompt };
  });
  if (new Set(entries.map((entry) => entry.id)).size !== entries.length)
    throw new ConnectError("Native task catalog contains duplicate tasks", Code.FailedPrecondition);
  return new TaskGraph(entries, [...sessions.values()].map(sessionInfo), agents);
}
