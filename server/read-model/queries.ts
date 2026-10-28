import { EventEmitter } from "node:events";
import { Code, ConnectError } from "@connectrpc/connect";
import type { Message } from "../../gen/a2a_pb.js";
import type { ExecutionBinding } from "../../gen/agentos/execution/v1/identity_pb.js";
import type { ExecutionStore } from "../authorization/store.js";
import { eachPage, type KagentClients, pool } from "../kagent/clients.js";
import { acceptMessage } from "../kagent/send.js";
import { agentInfo, agentKey, sessionInfo } from "./agents.js";
import { hitlExtension } from "./decode/hitl.js";
import { ingest } from "./entry.js";
import { TaskGraph } from "./graph.js";
import { listings } from "./listings.js";

const rpc = { timeoutMs: 10_000 };
const missing = (error: unknown) => error instanceof ConnectError && error.code === Code.NotFound;
const owner = (binding: ExecutionBinding) => ({
  root: binding.rootSessionId,
  subject: binding.subject,
});

/** Native reads; AgentOS stores execution ownership, without copying task state. */
export function taskQueries(options: {
  workspace: string;
  clients: KagentClients;
  executions: Pick<ExecutionStore, "binding" | "inventory" | "exclusive">;
}) {
  const { clients, executions, workspace } = options;
  const changes = new EventEmitter().setMaxListeners(0);

  async function agents() {
    const [{ agents }, { agentTemplates }] = await Promise.all([
      clients.agents.listAgents({ namespace: workspace }, rpc),
      clients.templates.listAgentTemplates({ namespace: workspace }, rpc),
    ]);
    const templates = new Map(agentTemplates.map((template) => [agentKey(template.ref), template]));
    return agents.map((agent) => agentInfo(agent, templates));
  }

  async function session(id: string) {
    const binding = await executions.binding(id);
    if (!binding) return undefined;
    try {
      const { session } = await clients.sessions.getSession({ sessionId: id }, rpc);
      return session?.agent && agentKey(session.agent) === agentKey(binding.value.agent)
        ? { ...sessionInfo(session), ...owner(binding.value) }
        : undefined;
    } catch (error) {
      if (missing(error)) return undefined;
      throw error;
    }
  }

  /** Reads every native page of the selected authorized conversations. */
  async function load(bindings: ExecutionBinding[]) {
    const entries: ReturnType<typeof ingest>[] = [];
    const sessions: NonNullable<Awaited<ReturnType<typeof session>>>[] = [];
    await pool(bindings, 4, async (binding) => {
      const known = await session(binding.sessionId);
      if (!known) return;
      sessions.push(known);
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
        (tasks) => {
          for (const task of tasks)
            if (task.contextId === known.id) entries.push(ingest(task, known.agentId));
        },
      );
    });
    return new TaskGraph(entries, sessions, await agents());
  }

  async function entry(id: string) {
    try {
      const task = await clients.a2a.getTask({ id }, rpc);
      const known = await session(task.contextId);
      return known
        ? { ...ingest(task, known.agentId), root: known.root, subject: known.subject }
        : undefined;
    } catch (error) {
      if (missing(error)) return undefined;
      throw error;
    }
  }

  async function graph(roots: string[]) {
    return load(await executions.inventory({ roots }));
  }

  return {
    ...listings(load, executions.inventory.bind(executions)),
    agents,
    async agent(id: string) {
      return (await agents()).find((agent) => agent.id === id);
    },
    session,
    entry,
    graph,
    async graphOf(id: { taskId?: string; contextId?: string }) {
      const value = id.taskId ? await entry(id.taskId) : await session(id.contextId ?? "");
      return value ? graph([value.root]) : undefined;
    },
    async taskOfMessage(messageId: string, subject: string) {
      return (await load(await executions.inventory({ subject }))).taskOfMessage(messageId);
    },
    async fullTask(value: { id: string; agentId: string }) {
      try {
        return await clients.a2a.getTask({ tenant: value.agentId, id: value.id }, rpc);
      } catch (error) {
        if (missing(error)) return undefined;
        throw error;
      }
    },
    async send(tenant: string, message: Message, headers?: Record<string, string>) {
      const task = await acceptMessage(clients.a2a, tenant, message, {
        ...headers,
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
    exclusive: executions.exclusive.bind(executions),
  };
}

export type TaskQueries = ReturnType<typeof taskQueries>;
