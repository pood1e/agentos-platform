import { toBinary } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import type { FastifyBaseLogger } from "fastify";
import { LRUCache } from "lru-cache";
import {
  type Message,
  type StreamResponse,
  type Task,
  TaskSchema,
  TaskState,
} from "../../gen/a2a_pb.js";
import { type KagentClients, pool } from "../kagent/clients.js";
import { statusMillis } from "./decode/messages.js";
import { ingest } from "./entry.js";
import { applyEvent } from "./events.js";
import type { TaskIndex } from "./index.js";
import { openMessage } from "./send.js";
import { interrupted, terminal } from "./state.js";

const rpc = { timeoutMs: 10_000 };
const settled = (state?: TaskState) => terminal(state) || interrupted(state);

/** Full task payloads: running tasks follow A2A subscriptions, settled tasks load on demand. */
export class LiveTasks {
  private running = new Map<string, Task>();
  private streams = new Map<string, AbortController>();
  private retries = new Map<string, { attempts: number; after: number }>();
  private reload = new Set<string>();
  private details = new LRUCache<string, { version: string; task: Task }>({
    maxSize: 64 * 1024 * 1024,
    sizeCalculation: ({ task }) => toBinary(TaskSchema, task).byteLength || 1,
  });

  constructor(
    private clients: KagentClients,
    private index: TaskIndex,
    private log: FastifyBaseLogger,
    private lifetime: AbortSignal,
  ) {}

  close(): void {
    for (const controller of this.streams.values()) controller.abort();
  }

  forgetSession(contextId: string): void {
    for (const entry of this.index.contextEntries(contextId)) {
      this.streams.get(entry.id)?.abort();
      this.streams.delete(entry.id);
      this.running.delete(entry.id);
      this.retries.delete(entry.id);
      this.reload.delete(entry.id);
      this.details.delete(entry.id);
    }
    this.index.removeSession(contextId);
  }

  /** The listed status differs from the index, or the task lost its subscription. */
  changed(task: Task): boolean {
    const entry = this.index.entry(task.id);
    return (
      this.reload.has(task.id) ||
      entry?.state !== task.status?.state ||
      entry?.statusAt !== statusMillis(task)
    );
  }

  store(task: Task, tenant: string) {
    const running = this.running.get(task.id);
    const current =
      running &&
      !this.reload.has(task.id) &&
      running.status?.state === task.status?.state &&
      (statusMillis(running) ?? 0) >= (statusMillis(task) ?? 0)
        ? running
        : task;
    const entry = ingest(current, tenant);
    this.reload.delete(task.id);
    if (settled(current.status?.state)) {
      this.running.delete(task.id);
      this.retries.delete(task.id);
      // Only recently active tasks are likely to be opened; others load on demand.
      if (running) this.details.set(task.id, { version: entry.version, task: current });
    } else this.running.set(task.id, current);
    this.index.upsert(entry);
  }

  /** A broken subscription is reloaded directly; a long run may never change its status time. */
  async reloadInterrupted() {
    const due = [...this.reload].filter((id) => (this.retries.get(id)?.after ?? 0) <= Date.now());
    await pool(due, 4, async (id) => {
      const entry = this.index.entry(id);
      if (!entry) return void this.reload.delete(id);
      await this.reloadTask(id, entry.agentId);
    });
  }

  async reloadTask(id: string, tenant: string): Promise<void> {
    const task = await this.fetch(id, tenant);
    if (task) this.store(task, tenant);
  }

  follow() {
    for (const entry of this.index.all()) {
      if (entry.state !== TaskState.WORKING && entry.state !== TaskState.SUBMITTED) continue;
      if (this.streams.has(entry.id) || this.reload.has(entry.id)) continue;
      if ((this.retries.get(entry.id)?.after ?? 0) > Date.now()) continue;
      const controller = new AbortController();
      const signal = AbortSignal.any([controller.signal, this.lifetime]);
      this.streams.set(entry.id, controller);
      const stream = this.clients.a2a.subscribeToTask(
        { tenant: entry.agentId, id: entry.id },
        { signal },
      );
      void this.consume(entry.id, entry.agentId, stream, controller);
    }
  }

  /** Sends a message, waits for its task, then keeps following the stream. */
  async send(tenant: string, message: Message, headers?: Record<string, string>): Promise<Task> {
    const baseline = message.taskId ? await this.fullTask(message.taskId) : undefined;
    const { task, controller, events } = await openMessage(
      this.clients,
      tenant,
      message,
      baseline,
      this.lifetime,
      headers,
    );
    this.running.set(task.id, task);
    this.reload.delete(task.id);
    this.retries.delete(task.id);
    this.index.upsert(ingest(task, tenant));
    await this.index.checkpoint();
    this.index.flush();
    this.streams.get(task.id)?.abort();
    this.streams.set(task.id, controller);
    void this.consume(task.id, tenant, events, controller);
    return task;
  }

  /** Complete task with history and artifacts for detail views. */
  async fullTask(id: string): Promise<Task | undefined> {
    const running = this.running.get(id);
    if (running) return running;
    const entry = this.index.entry(id);
    if (!entry) return undefined;
    const cached = this.details.get(id);
    if (cached?.version === entry.version) return cached.task;
    const task = await this.fetch(id, entry.agentId);
    if (task) this.details.set(id, { version: entry.version, task });
    return task;
  }

  private async fetch(id: string, tenant: string): Promise<Task | undefined> {
    try {
      return await this.clients.a2a.getTask({ tenant, id }, { ...rpc, signal: this.lifetime });
    } catch (error) {
      if (!(error instanceof ConnectError) || error.code !== Code.NotFound) throw error;
      this.streams.get(id)?.abort();
      this.running.delete(id);
      this.reload.delete(id);
      this.retries.delete(id);
      this.details.delete(id);
      this.index.remove(id);
      return undefined;
    }
  }

  private async consume(
    id: string,
    tenant: string,
    stream: AsyncIterable<StreamResponse>,
    controller: AbortController,
  ) {
    try {
      for await (const event of stream) {
        const task = applyEvent(this.running.get(id) ?? (await this.fullTask(id)), event);
        if (!task) continue;
        if (task.id !== id) throw new Error("A2A stream changed task identity");
        this.running.set(id, task);
        this.index.upsert(ingest(task, tenant));
        await this.index.checkpoint();
        this.index.flush();
        if (settled(task.status?.state)) break;
      }
      if (!settled(this.index.entry(id)?.state) && !controller.signal.aborted)
        throw new Error("A2A subscription ended before the task paused or finished");
      this.retries.delete(id);
    } catch (error) {
      if (!controller.signal.aborted) {
        // The durable task is reloaded before subscribing again.
        this.running.delete(id);
        this.reload.add(id);
        const attempts = (this.retries.get(id)?.attempts ?? 0) + 1;
        this.retries.set(id, {
          attempts,
          after: Date.now() + Math.min(500 * 2 ** attempts, 30_000),
        });
        this.log.warn({ err: error, taskId: id }, "A2A subscription interrupted");
      }
    } finally {
      if (this.streams.get(id) === controller) {
        this.streams.delete(id);
        const task = this.running.get(id);
        if (task && settled(task.status?.state)) {
          this.running.delete(id);
          this.details.set(id, { version: this.index.entry(id)?.version ?? "", task });
        }
      }
      controller.abort();
    }
  }
}
