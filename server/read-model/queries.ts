import { EventEmitter } from "node:events";
import { Code, ConnectError } from "@connectrpc/connect";
import type { Message } from "../../gen/a2a_pb.js";
import type { Session } from "../../gen/kagent/api/v1/sessions_pb.js";
import { eachPage, type KagentClients, pool } from "../kagent/clients.js";
import { acceptMessage } from "../kagent/send.js";
import { agentInfo, agentKey, type SessionInfo, sessionInfo } from "./agents.js";
import { hitlExtension } from "./decode/hitl.js";
import { ingest, type TaskEntry } from "./entry.js";
import { TaskGraph } from "./graph.js";
import { listings, type Viewer } from "./listings.js";

const rpc = { timeoutMs: 10_000 };
const missing = (error: unknown) => error instanceof ConnectError && error.code === Code.NotFound;

/** Native Sessions, A2A tasks and trusted execution relationships form one read model. */
export function taskQueries({ workspace, clients }: { workspace: string; clients: KagentClients }) {
  const changes = new EventEmitter().setMaxListeners(0);
  async function agents() {
    const [{ agents }, { agentTemplates }] = await Promise.all([
      clients.agents.listAgents({ namespace: workspace }, rpc),
      clients.templates.listAgentTemplates({ namespace: workspace }, rpc),
    ]);
    const templates = new Map(agentTemplates.map((value) => [agentKey(value.ref), value]));
    return agents.map((value) => agentInfo(value, templates));
  }
  async function session(id: string) {
    try {
      const { session } = await clients.sessions.getSession({ sessionId: id }, rpc);
      return session?.agent?.namespace === workspace ? sessionInfo(session) : undefined;
    } catch (error) {
      if (missing(error)) return undefined;
      throw error;
    }
  }
  async function inventory(options: { roots?: string[]; viewer?: Viewer } = {}) {
    const sessions: Session[] = [];
    const rootIds = options.roots?.length ? options.roots : [""];
    for (const rootSessionId of rootIds)
      await eachPage(
        async (pageToken) => {
          const page = await clients.sessions.listSessions(
            {
              rootSessionId,
              allCreators: !rootSessionId && options.viewer?.administrator === true,
              page: { limit: 100, pageToken },
            },
            rpc,
          );
          return { items: page.sessions, token: page.page?.nextPageToken ?? "" };
        },
        (items) => sessions.push(...items),
      );
    return sessions
      .filter((value) => value.agent?.namespace === workspace)
      .filter(
        (value) =>
          !options.viewer?.systemOnly || value.authority?.initiatorId !== options.viewer.subject,
      )
      .map(sessionInfo);
  }
  async function withExecution(task: Parameters<typeof ingest>[0], agentId: string) {
    const { execution } = await clients.execution.getTaskExecution({ taskId: task.id }, rpc);
    if (execution?.task?.taskId !== task.id || execution.task.sessionId !== task.contextId)
      throw new ConnectError("Native task relationship unavailable", Code.FailedPrecondition);
    return ingest(task, agentId, execution);
  }
  async function load(sessions: SessionInfo[]) {
    const entries: TaskEntry[] = [];
    await pool(sessions, 4, async (known) => {
      const tasks: Parameters<typeof ingest>[0][] = [];
      await eachPage(
        async (pageToken) => {
          const page = await clients.a2a.listTasks(
            {
              tenant: known.agentId,
              contextId: known.id,
              pageSize: 100,
              pageToken,
              includeArtifacts: true,
            },
            rpc,
          );
          return { items: page.tasks, token: page.nextPageToken };
        },
        (items) => tasks.push(...items.filter((task) => task.contextId === known.id)),
      );
      await pool(tasks, 4, async (task) => {
        entries.push(await withExecution(task, known.agentId));
      });
    });
    return new TaskGraph(entries, sessions, await agents());
  }
  async function entry(id: string) {
    try {
      const task = await clients.a2a.getTask({ id }, rpc);
      const known = await session(task.contextId);
      return known
        ? {
            ...(await withExecution(task, known.agentId)),
            root: known.root,
            subject: known.subject,
          }
        : undefined;
    } catch (error) {
      if (missing(error)) return undefined;
      throw error;
    }
  }
  const graph = async (roots: string[]) => load(await inventory({ roots }));
  return {
    ...listings(load, async (viewer) => inventory({ viewer })),
    agents,
    session,
    entry,
    graph,
    async agent(id: string) {
      return (await agents()).find((value) => value.id === id);
    },
    async graphOf(id: { taskId?: string; contextId?: string }) {
      const value = id.taskId ? await entry(id.taskId) : await session(id.contextId ?? "");
      return value ? graph([value.root]) : undefined;
    },
    async fullTask(value: { id: string; agentId: string }) {
      try {
        return await clients.a2a.getTask({ tenant: value.agentId, id: value.id }, rpc);
      } catch (error) {
        if (missing(error)) return undefined;
        throw error;
      }
    },
    async send(tenant: string, message: Message) {
      const task = await acceptMessage(clients.a2a, tenant, message, {
        "A2A-Extensions": hitlExtension,
      });
      changes.emit("change");
      return task;
    },
    onChange(listener: () => void) {
      changes.on("change", listener);
      return () => {
        changes.off("change", listener);
      };
    },
  };
}
export type TaskQueries = ReturnType<typeof taskQueries>;
