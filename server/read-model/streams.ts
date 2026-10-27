import type { Task, TaskState } from "../../gen/a2a_pb.js";
import type { KagentClients } from "../kagent/clients.js";
import { statusMillis } from "./decode/messages.js";
import type { TaskEntry } from "./entry.js";
import { applyEvent } from "./events.js";
import { interrupted, terminal } from "./state.js";

const settled = (state?: TaskState) => terminal(state) || interrupted(state);

/** Text deltas of the running tasks one viewer watches; they never enter the projection. */
export class TaskStreams {
  private tasks = new Map<string, Task>();
  private streams = new Map<string, AbortController>();

  constructor(
    private clients: Pick<KagentClients, "a2a">,
    private signal: AbortSignal,
    private changed: () => void,
  ) {}

  /** Subscribes to running tasks and drops the ones that settled. */
  follow(entries: TaskEntry[]) {
    for (const entry of entries) {
      const snapshot = this.tasks.get(entry.id);
      if (snapshot && (statusMillis(snapshot) ?? 0) < (entry.statusAt ?? 0))
        this.tasks.delete(entry.id);
    }
    const running = new Map(
      entries
        .filter((entry) => !settled(this.tasks.get(entry.id)?.status?.state ?? entry.state))
        .map((entry) => [entry.id, entry]),
    );
    for (const [id, controller] of this.streams)
      if (!running.has(id)) {
        controller.abort();
        this.streams.delete(id);
      }
    for (const [id, entry] of running) {
      if (this.streams.has(id)) continue;
      const controller = new AbortController();
      this.streams.set(id, controller);
      void this.consume(entry, controller);
    }
    const known = new Set(entries.map((entry) => entry.id));
    for (const id of this.tasks.keys()) if (!known.has(id)) this.tasks.delete(id);
  }

  task = (id: string) => this.tasks.get(id);

  close() {
    for (const controller of this.streams.values()) controller.abort();
  }

  private async consume(entry: TaskEntry, controller: AbortController) {
    try {
      const stream = this.clients.a2a.subscribeToTask(
        { tenant: entry.agentId, id: entry.id },
        { signal: AbortSignal.any([controller.signal, this.signal]) },
      );
      for await (const event of stream) {
        const task = applyEvent(this.tasks.get(entry.id), event);
        if (!task) continue;
        this.tasks.set(entry.id, task);
        this.changed();
        if (settled(task.status?.state)) break;
      }
    } catch {
      // Viewers fall back to the projection and the stored task.
    } finally {
      if (this.streams.get(entry.id) === controller) this.streams.delete(entry.id);
    }
  }
}
