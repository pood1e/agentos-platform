import { Mutex } from "async-mutex";

/** Changes stay pending until every durable consumer has accepted them. */
export class Checkpoints {
  private pending = new Map<string, number>();
  private listeners = new Set<(ids: ReadonlySet<string>) => Promise<void>>();
  private lock = new Mutex();
  private revision = 0;

  touch(id: string) {
    this.pending.set(id, ++this.revision);
  }

  subscribe(listener: (ids: ReadonlySet<string>) => Promise<void>) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  commit() {
    return this.lock.runExclusive(async () => {
      const batch = new Map(this.pending);
      if (!batch.size) return;
      const ids = new Set(batch.keys());
      for (const listener of this.listeners) await listener(ids);
      for (const [id, revision] of batch)
        if (this.pending.get(id) === revision) this.pending.delete(id);
    });
  }
}
