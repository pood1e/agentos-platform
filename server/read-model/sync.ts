import { setTimeout as delay } from "node:timers/promises";
import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import type { FastifyBaseLogger } from "fastify";
import type { Message, Task } from "../../gen/a2a_pb.js";
import { eachPage, type KagentClients, pool } from "../kagent/clients.js";
import { agentInfo, agentKey, sessionInfo } from "./agents.js";
import { statusMillis } from "./decode/messages.js";
import type { TaskIndex } from "./index.js";
import { LiveTasks } from "./live.js";

const interval = 2_000;
// kagent filters status timestamps strictly; overlap so equal timestamps are not skipped.
const overlap = 2_000;
const rpc = { timeoutMs: 10_000 };

/** Keeps the task index current with incremental listing and live task subscriptions. */
export class KagentSync {
  private tenants = new Set<string>();
  private watermarks = new Map<string, number>();
  private unresolved = new Map<string, number>();
  private lifetime = new AbortController();
  private tasks: LiveTasks;
  private running?: Promise<void>;
  private sessionsLoaded = false;
  private lastSuccess = 0;
  private lastLogged = 0;

  constructor(
    private clients: KagentClients,
    private namespace: string,
    readonly index: TaskIndex,
    private log: FastifyBaseLogger,
  ) {
    this.tasks = new LiveTasks(clients, index, log, this.lifetime.signal);
  }

  start(): void {
    void (async () => {
      while (!this.lifetime.signal.aborted) {
        await this.refresh().catch((error: unknown) => this.failed(error));
        await delay(interval, undefined, { signal: this.lifetime.signal }).catch(() => {});
      }
    })();
  }

  healthy = () => Date.now() - this.lastSuccess < 5 * interval;

  refresh(): Promise<void> {
    this.running ??= this.tick().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  close(): void {
    this.lifetime.abort();
    this.tasks.close();
  }

  private options() {
    return { ...rpc, signal: this.lifetime.signal };
  }

  private async tick() {
    const [{ agents }, { agentTemplates }] = await Promise.all([
      this.clients.agents.listAgents({ namespace: this.namespace }, this.options()),
      this.clients.templates.listAgentTemplates({ namespace: this.namespace }, this.options()),
    ]);
    const templates = new Map(agentTemplates.map((template) => [agentKey(template.ref), template]));
    this.index.setAgents(agents.map((agent) => agentInfo(agent, templates)));
    for (const agent of agents) this.tenants.add(agentKey(agent.ref));
    if (!this.sessionsLoaded) await this.loadSessions();
    await pool([...this.tenants], 4, (tenant) => this.syncTenant(tenant));
    await this.tasks.reloadInterrupted();
    await this.discoverSessions();
    this.tasks.follow();
    this.lastSuccess = Date.now();
    this.index.flush();
  }

  private failed(error: unknown) {
    if (this.lifetime.signal.aborted) return;
    if (Date.now() - this.lastLogged < 60_000) return;
    this.lastLogged = Date.now();
    this.log.error({ err: error }, "kagent synchronization failed");
  }

  private async loadSessions() {
    await eachPage(
      async (pageToken) => {
        const page = await this.clients.sessions.listSessions(
          { page: { limit: 100, pageToken } },
          this.options(),
        );
        return { items: page.sessions, token: page.page?.nextPageToken ?? "" };
      },
      (sessions) => {
        for (const session of sessions) {
          if (session.agent?.namespace !== this.namespace) continue;
          this.index.setSession(sessionInfo(session));
          this.tenants.add(agentKey(session.agent));
        }
      },
    );
    this.sessionsLoaded = true;
  }

  /**
   * The first listing carries full tasks. Later listings carry status only, and
   * tasks whose status changed are fetched individually.
   */
  private async syncTenant(tenant: string) {
    const after = this.watermarks.get(tenant);
    const changed: Task[] = [];
    let watermark = after;
    await eachPage(
      async (pageToken) => {
        const page = await this.clients.a2a.listTasks(
          {
            tenant,
            pageSize: 100,
            pageToken,
            includeArtifacts: after === undefined,
            historyLength: after === undefined ? undefined : 0,
            statusTimestampAfter:
              after === undefined ? undefined : timestampFromMs(after - overlap),
          },
          this.options(),
        );
        return { items: page.tasks, token: page.nextPageToken };
      },
      (tasks) => {
        for (const task of tasks) {
          watermark = Math.max(watermark ?? 0, statusMillis(task) ?? 0);
          if (after === undefined) this.tasks.store(task, tenant);
          else if (this.tasks.changed(task)) changed.push(task);
        }
      },
    );
    await pool(changed, 4, async (task) =>
      this.tasks.store(
        await this.clients.a2a.getTask({ tenant, id: task.id }, this.options()),
        tenant,
      ),
    );
    this.watermarks.set(tenant, watermark ?? 0);
  }

  /** Session metadata names conversations and reveals agents that left the namespace list. */
  private async discoverSessions() {
    const unknown = this.index
      .unknownSessions()
      .filter((id) => id && !this.index.session(id) && (this.unresolved.get(id) ?? 0) < Date.now());
    await pool(unknown, 4, async (sessionId) => {
      try {
        const { session } = await this.clients.sessions.getSession({ sessionId }, this.options());
        if (!session?.agent) return;
        this.index.setSession(sessionInfo(session));
        this.tenants.add(agentKey(session.agent));
      } catch {
        this.unresolved.set(sessionId, Date.now() + 60_000);
      }
    });
  }

  send(tenant: string, message: Message, headers?: Record<string, string>): Promise<Task> {
    return this.tasks.send(tenant, message, headers);
  }

  fullTask(id: string): Promise<Task | undefined> {
    return this.tasks.fullTask(id);
  }
}
