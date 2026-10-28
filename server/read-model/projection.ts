import { EventEmitter } from "node:events";
import { toBinary } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { LRUCache } from "lru-cache";
import { type Message, type Task, TaskSchema } from "../../gen/a2a_pb.js";
import type { ExecutionStore } from "../authorization/store.js";
import type { KagentClients } from "../kagent/clients.js";
import { acceptMessage } from "../kagent/send.js";
import { type AgentInfo, agentKey, type SessionInfo } from "./agents.js";
import { hitlExtension } from "./decode/hitl.js";
import { statusMillis } from "./decode/messages.js";
import { ingest, type TaskEntry } from "./entry.js";
import { TaskGraph } from "./graph.js";
import { listings } from "./listings.js";
import { terminal } from "./state.js";
import { type Owner, type ProjectionChange, type ReadWriter, readStore } from "./store.js";
import { storeSummaries, summarize } from "./summaries.js";

/** Runs inside the projection transaction of one execution tree, e.g. to enqueue coordination. */
export type ProjectionHook = (
  graph: TaskGraph,
  changed: ReadonlySet<string>,
  writer: ReadWriter,
) => Promise<void>;

export interface Native {
  task: Task;
  agentId: string;
}

const notified = 100;
const heartbeat = 5_000;
/** Without a delivered heartbeat for this long the subscription is renewed and viewers fail over. */
const silence = 15_000;

export async function taskProjection(options: {
  uri: string;
  workspace: string;
  ca?: string;
  clients: KagentClients;
  executions: Pick<ExecutionStore, "bindings">;
}) {
  const { clients, workspace } = options;
  const store = await readStore(options.uri, workspace, options.ca);
  const changes = new EventEmitter().setMaxListeners(0);
  const hooks: ProjectionHook[] = [];
  const details = new LRUCache<string, Task>({
    maxSize: 64 * 1024 * 1024,
    sizeCalculation: (task) => toBinary(TaskSchema, task).byteLength || 1,
  });
  let subscription: Awaited<ReturnType<typeof store.listen>> | undefined;
  let subscribing: Promise<void> | undefined;
  let beats: ReturnType<typeof setInterval> | undefined;
  let heard = 0;

  /** Changes missed while unsubscribed are unknown, so every viewer reloads. */
  function subscribe() {
    subscribing ??= (async () => {
      await subscription?.unlisten().catch(() => {});
      subscription = await store.listen(
        (change) => changes.emit("change", change),
        () => {
          heard = Date.now();
        },
        () => {
          heard = Date.now();
          changes.emit("change", { roots: [], ids: [] } satisfies ProjectionChange);
        },
      );
    })().finally(() => {
      subscribing = undefined;
    });
    return subscribing;
  }

  /** Bindings place sessions in their execution tree when the bound Agent matches. */
  async function owners(contexts: string[], agents: ReadonlyMap<string, string>) {
    const bound = await options.executions.bindings(contexts);
    return new Map<string, Owner>(
      bound
        .filter(
          (binding) =>
            !agents.get(binding.sessionId) ||
            agents.get(binding.sessionId) === agentKey(binding.agent),
        )
        .map((binding) => [
          binding.sessionId,
          { root: binding.rootSessionId, subject: binding.subject },
        ]),
    );
  }

  async function project(writer: ReadWriter, roots: string[], written: string[]) {
    const agents = await writer.agents();
    for (const root of [...new Set(roots)].sort()) {
      await writer.lock(root);
      const tree = await writer.tree([root]);
      const graph = new TaskGraph(tree.entries, tree.sessions, agents);
      // An emptied tree has no owner left; its summaries are removed.
      const subject = (await writer.subjectOf(root)) ?? "";
      await storeSummaries(writer, workspace, root, subject, summarize(graph));
      const changed = new Set(written);
      for (const hook of hooks) await hook(graph, changed, writer);
      const ids = written.filter(
        (id) => graph.entry(id) || graph.session(id.slice("session:".length)),
      );
      await writer.notify({ roots: [root], ids: ids.length > notified ? [] : ids });
    }
  }

  /** Projects native tasks and sessions; writes without projected changes are no-ops. */
  const apply = (tasks: Native[], sessions: SessionInfo[] = []) =>
    applyEntries(
      tasks.map(({ task, agentId }) => ingest(task, agentId)),
      sessions,
    );

  async function applyEntries(entries: TaskEntry[], sessions: SessionInfo[] = []) {
    const agents = new Map<string, string>([
      ...entries.map((entry) => [entry.contextId, entry.agentId] as const),
      ...sessions.map((session) => [session.id, session.agentId] as const),
    ]);
    if (!agents.size) return;
    const bound = await owners([...agents.keys()], agents);
    await store.write(async (writer) => {
      const written = [
        ...(await writer.tasks(entries, bound)),
        ...(await writer.sessions(sessions, bound)),
        ...(await writer.adopt(bound)),
      ];
      if (written.length) await project(writer, await writer.rootsOf([...agents.keys()]), written);
    });
  }

  /** All tasks of the given execution trees. */
  async function graph(roots: string[]) {
    const [tree, agents] = await Promise.all([store.tree(roots), store.agents()]);
    return new TaskGraph(tree.entries, tree.sessions, agents);
  }

  /** Tasks kagent no longer has leave their trees. */
  async function remove(ids: string[]) {
    if (!ids.length) return;
    await store.write(async (writer) => {
      const contexts = (await Promise.all(ids.map((id) => writer.contextOf(id)))).flatMap(
        (context) => context ?? [],
      );
      const roots = await writer.rootsOf(contexts);
      const removed = await writer.remove(ids);
      if (removed.length) await project(writer, roots, removed);
    });
  }

  async function forgetSession(id: string) {
    await store.write(async (writer) => {
      const roots = await writer.rootsOf([id]);
      const removed = await writer.forget(id);
      await project(writer, roots, [...removed, `session:${id}`]);
    });
  }

  return {
    workspace,
    store,
    ...listings(store),
    apply,
    applyEntries,
    remove,
    forgetSession,
    hook: (hook: ProjectionHook) => hooks.push(hook),
    entry: (id: string) => store.entry(id),
    session: (id: string) => store.session(id),
    async taskOfMessage(messageId: string) {
      const id = await store.taskOfMessage(messageId);
      return id ? store.entry(id) : undefined;
    },
    agents: (): Promise<AgentInfo[]> => store.agents(),
    async agent(id: string) {
      return (await store.agents()).find((agent) => agent.id === id);
    },
    graph,
    /** The execution tree of a task or session; undefined when it was never bound. */
    async graphOf(id: { taskId?: string; contextId?: string }) {
      const root = id.taskId
        ? (await store.entry(id.taskId))?.root
        : (await store.session(id.contextId ?? ""))?.root;
      return root ? graph([root]) : undefined;
    },
    /** Complete task with history and artifacts; finished tasks are cached by status time. */
    async fullTask(entry: Pick<TaskEntry, "id" | "agentId" | "state" | "statusAt">) {
      const cached = details.get(entry.id);
      if (cached && terminal(entry.state) && statusMillis(cached) === entry.statusAt) return cached;
      try {
        const task = await clients.a2a.getTask(
          { tenant: entry.agentId, id: entry.id },
          { timeoutMs: 10_000 },
        );
        if (terminal(task.status?.state)) details.set(entry.id, task);
        return task;
      } catch (error) {
        if (error instanceof ConnectError && error.code === Code.NotFound) return undefined;
        throw error;
      }
    },
    /** Sends without holding a stream; the runtime's own writes carry the task forward. */
    async send(tenant: string, message: Message, headers?: Record<string, string>) {
      const task = await acceptMessage(clients.a2a, tenant, message, {
        ...headers,
        "A2A-Extensions": hitlExtension,
      });
      await apply([{ task, agentId: tenant }]);
      return task;
    },
    /** Subscribes viewers of this replica to committed changes of every writer. */
    async listen() {
      await subscribe();
      beats = setInterval(() => {
        if (Date.now() - heard > silence) void subscribe().catch(() => {});
        void store.heartbeat().catch(() => {});
      }, heartbeat);
    },
    onChange(listener: (change: ProjectionChange) => void): () => void {
      changes.on("change", listener);
      return () => {
        changes.off("change", listener);
      };
    },
    /** Change notifications reach this replica, so open views stay current. */
    healthy: () => Date.now() - heard < silence,
    exclusive: store.exclusive,
    /** The database answers within the readiness budget. */
    async reachable() {
      const probe = store.sql`select 1`;
      const timer = setTimeout(() => probe.cancel(), 2_000);
      try {
        await probe;
        return true;
      } catch {
        return false;
      } finally {
        clearTimeout(timer);
      }
    },
    async close() {
      clearInterval(beats);
      await subscription?.unlisten().catch(() => {});
      await store.close();
    },
  };
}

export type TaskProjection = Awaited<ReturnType<typeof taskProjection>>;
