import { setTimeout as delay } from "node:timers/promises";
import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError } from "@connectrpc/connect";
import type { FastifyBaseLogger } from "fastify";
import type { Task } from "../../gen/a2a_pb.js";
import { eachPage, type KagentClients, pool } from "../kagent/clients.js";
import { agentInfo, agentKey, type SessionInfo, sessionInfo } from "./agents.js";
import { statusMillis } from "./decode/messages.js";
import type { Native, TaskProjection } from "./projection.js";

// kagent filters status timestamps strictly; overlap so equal timestamps are not skipped.
const overlap = 2_000;
const batch = 50;
const rpc = { timeoutMs: 10_000 };
/** Watermark key recording that the one-time session backfill finished. */
const sessionsLoaded = "sessions";

/** Re-reads whole conversations natively, before decisions that must not act on stale state. */
export async function refreshContexts(
  projection: Pick<TaskProjection, "apply">,
  clients: Pick<KagentClients, "a2a">,
  contexts: { id: string; agentId: string }[],
  signal?: AbortSignal,
) {
  const tasks: Native[] = [];
  await pool(contexts, 4, async ({ id, agentId }) => {
    await eachPage(
      async (pageToken) => {
        const page = await clients.a2a.listTasks(
          { tenant: agentId, contextId: id, pageSize: 100, pageToken, includeArtifacts: true },
          { ...rpc, signal },
        );
        return { items: page.tasks, token: page.nextPageToken };
      },
      (page) => tasks.push(...page.map((task) => ({ task, agentId }))),
    );
  });
  await projection.apply(tasks);
}

/** Projects a session the platform has not observed yet, with its tasks. */
export async function refreshSession(
  projection: Pick<TaskProjection, "apply">,
  clients: Pick<KagentClients, "a2a" | "sessions">,
  sessionId: string,
  signal?: AbortSignal,
) {
  const { session } = await clients.sessions.getSession({ sessionId }, { ...rpc, signal });
  if (!session?.agent) return;
  await projection.apply([], [sessionInfo(session)]);
  await refreshContexts(
    projection,
    clients,
    [{ id: session.id, agentId: agentKey(session.agent) }],
    signal,
  );
}

/** Brings kagent-side changes into the projection; requests follow activity, not history. */
export function reconciler(
  projection: TaskProjection,
  clients: KagentClients,
  namespace: string,
  log: Pick<FastifyBaseLogger, "error">,
  interval = 2_000,
) {
  const { store } = projection;
  const lifetime = new AbortController();
  const unresolved = new Map<string, number>();
  let running: Promise<void> | undefined;
  let lastLogged = 0;
  const options = () => ({ ...rpc, signal: lifetime.signal });

  async function apply(tasks: Native[] = [], sessions: SessionInfo[] = []) {
    for (let start = 0; start < Math.max(tasks.length, sessions.length); start += batch)
      await projection.apply(
        tasks.slice(start, start + batch),
        sessions.slice(start, start + batch),
      );
  }

  async function backfillSessions() {
    const sessions: SessionInfo[] = [];
    await eachPage(
      async (pageToken) => {
        const page = await clients.sessions.listSessions(
          { page: { limit: 100, pageToken } },
          options(),
        );
        return { items: page.sessions, token: page.page?.nextPageToken ?? "" };
      },
      (page) => {
        for (const session of page)
          if (session.agent?.namespace === namespace) sessions.push(sessionInfo(session));
      },
    );
    await apply([], sessions);
    await store.setWatermark(sessionsLoaded, Date.now());
  }

  /** Lists status since the watermark; only tasks whose status moved are fetched in full. */
  async function tenant(id: string) {
    const after = await store.watermark(id);
    const listed: Task[] = [];
    await eachPage(
      async (pageToken) => {
        const page = await clients.a2a.listTasks(
          {
            tenant: id,
            pageSize: 100,
            pageToken,
            includeArtifacts: false,
            historyLength: 0,
            statusTimestampAfter:
              after === undefined ? undefined : timestampFromMs(after - overlap),
          },
          options(),
        );
        return { items: page.tasks, token: page.nextPageToken };
      },
      (tasks) => listed.push(...tasks),
    );
    const stored = await store.statuses(listed.map((task) => task.id));
    const changed = listed.filter((task) => {
      const known = stored.get(task.id);
      const statusAt = known?.statusAt === null ? undefined : Number(known?.statusAt);
      return known?.state !== task.status?.state || statusAt !== statusMillis(task);
    });
    const tasks: Native[] = [];
    const deleted: string[] = [];
    await pool(changed, 4, async (task) => {
      try {
        tasks.push({
          task: await clients.a2a.getTask({ tenant: id, id: task.id }, options()),
          agentId: id,
        });
      } catch (error) {
        if (!(error instanceof ConnectError) || error.code !== Code.NotFound) throw error;
        deleted.push(task.id);
      }
    });
    await apply(tasks);
    await projection.remove(deleted);
    await store.setWatermark(
      id,
      Math.max(after ?? 0, ...listed.map((task) => statusMillis(task) ?? 0)),
    );
  }

  /** Session metadata names conversations and reveals agents outside the namespace list. */
  async function discoverSessions() {
    const unknown = (await store.unknownSessions()).filter(
      (id) => (unresolved.get(id) ?? 0) < Date.now(),
    );
    const sessions: SessionInfo[] = [];
    await pool(unknown, 4, async (sessionId) => {
      try {
        const { session } = await clients.sessions.getSession({ sessionId }, options());
        if (session?.agent) sessions.push(sessionInfo(session));
      } catch {
        unresolved.set(sessionId, Date.now() + 60_000);
      }
    });
    await apply([], sessions);
  }

  async function tick() {
    const [{ agents }, { agentTemplates }] = await Promise.all([
      clients.agents.listAgents({ namespace }, options()),
      clients.templates.listAgentTemplates({ namespace }, options()),
    ]);
    const templates = new Map(agentTemplates.map((template) => [agentKey(template.ref), template]));
    await store.setAgents(agents.map((agent) => agentInfo(agent, templates)));
    if ((await store.watermark(sessionsLoaded)) === undefined) await backfillSessions();
    const tenants = new Set([
      ...agents.map((agent) => agentKey(agent.ref)),
      ...(await store.tenants()),
    ]);
    await pool([...tenants], 4, tenant);
    await discoverSessions();
    projection.reconciled();
  }

  const refresh = () => {
    running ??= tick().finally(() => {
      running = undefined;
    });
    return running;
  };

  return {
    refresh,
    start() {
      void (async () => {
        while (!lifetime.signal.aborted) {
          await refresh().catch((error: unknown) => {
            if (lifetime.signal.aborted || Date.now() - lastLogged < 60_000) return;
            lastLogged = Date.now();
            log.error({ err: error }, "kagent reconciliation failed");
          });
          await delay(interval, undefined, { signal: lifetime.signal }).catch(() => {});
        }
      })();
    },
    close: () => lifetime.abort(),
  };
}
