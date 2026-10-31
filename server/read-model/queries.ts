import { EventEmitter } from "node:events";
import { Code, ConnectError } from "@connectrpc/connect";
import type { Message } from "../../gen/a2a_pb.js";
import type { Session } from "../../gen/kagent/api/v1/sessions_pb.js";
import { eachPage, type KagentClients } from "../kagent/clients.js";
import { acceptMessage } from "../kagent/send.js";
import { agentInfo, agentKey, agentRef, type SessionInfo, sessionInfo } from "./agents.js";
import { runBackground } from "./background.js";
import { hitlExtension } from "./decode/hitl.js";
import { engineerRunListings } from "./engineer-runs.js";
import { ingest } from "./entry.js";
import { TaskGraph } from "./graph.js";
import { listings, type Viewer } from "./listings.js";
import { taskRecords } from "./records.js";

const rpc = { timeoutMs: 10_000 };
const missing = (error: unknown) => error instanceof ConnectError && error.code === Code.NotFound;

/** Native Sessions, A2A tasks and trusted execution relationships form one read model. */
export function taskQueries({ workspace, clients }: { workspace: string; clients: KagentClients }) {
  const changes = new EventEmitter().setMaxListeners(0);
  const records = taskRecords(clients);
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
  async function inventory(options: { roots?: string[]; viewer?: Viewer; agent?: string } = {}) {
    if (options.agent && agentRef(options.agent).namespace !== workspace) return [];
    const sessions: Session[] = [];
    const rootIds = options.roots?.length ? options.roots : [""];
    for (const rootSessionId of rootIds)
      await eachPage(
        async (pageToken) => {
          const page = await clients.sessions.listSessions(
            {
              rootSessionId,
              agent: options.agent ? agentRef(options.agent) : undefined,
              allCreators:
                !rootSessionId &&
                options.viewer?.administrator === true &&
                options.viewer.systemOnly === true,
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
      .filter((value) => !options.agent || agentKey(value.agent) === options.agent)
      .filter(
        (value) =>
          !options.viewer?.systemOnly ||
          (value.authority?.initiatorId || value.creator) !== options.viewer.subject,
      )
      .map(sessionInfo);
  }
  async function withExecution(task: Parameters<typeof ingest>[0], agentId: string) {
    const { execution } = await clients.execution.getTaskExecution({ taskId: task.id }, rpc);
    if (execution?.task?.taskId !== task.id || execution.task.sessionId !== task.contextId)
      throw new ConnectError("Native task relationship unavailable", Code.FailedPrecondition);
    return ingest(task, agentId, execution);
  }
  async function load(
    sessions: SessionInfo[],
    skipUnreadable = false,
    subject = "",
    overview = false,
  ) {
    const selected = await records.list(sessions, skipUnreadable);
    return new TaskGraph(
      overview
        ? await records.overview(selected, subject, skipUnreadable)
        : await records.read(selected, subject, skipUnreadable),
      sessions,
      await agents(),
    );
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
    ...engineerRunListings({
      list: async (viewer, agent) =>
        records.list(await inventory({ viewer, agent }), viewer.systemOnly === true),
      read: (viewer, selected) =>
        records.read(selected, viewer.subject, viewer.systemOnly === true),
      background: runBackground(clients, session, agents),
    }),
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
