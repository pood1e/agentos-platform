import type { TaskIndex } from "./index.js";
import { taskTree } from "./tree.js";

/** Tracks a conversation's execution tree, including delegation references awaiting discovery. */
export class ObservationScope {
  private tasks = new Set<string>();
  private contexts = new Set<string>();
  private messages = new Set<string>();

  constructor(
    private index: TaskIndex,
    private target: { contextId?: string; taskId?: string },
  ) {
    this.refresh();
  }

  refresh() {
    this.tasks = new Set();
    this.contexts = new Set(this.target.contextId ? [this.target.contextId] : []);
    this.messages = new Set();
    const roots = this.target.taskId
      ? [this.index.operationRoot(this.target.taskId)?.id ?? this.target.taskId]
      : this.index.contextEntries(this.target.contextId ?? "").map((entry) => entry.id);
    for (const root of roots) {
      const parent = this.index.relations().parents.get(root);
      if (parent) {
        this.tasks.add(parent);
        const context = this.index.entry(parent)?.contextId;
        if (context) this.contexts.add(context);
      }
    }
    for (const root of roots) {
      this.tasks.add(root);
      for (const entry of taskTree(this.index, root)?.entries ?? []) {
        this.tasks.add(entry.id);
        this.contexts.add(entry.contextId);
        for (const call of entry.calls) {
          const ref = call.delegation;
          if (ref?.sessionId) this.contexts.add(ref.sessionId);
          if (ref?.taskId) this.tasks.add(ref.taskId);
          if (ref?.messageId) this.messages.add(ref.messageId);
        }
      }
    }
  }

  affects = (changed: ReadonlySet<string>) => {
    for (const id of changed) {
      if (!id || this.tasks.has(id)) return true;
      if (id.startsWith("session:") && this.contexts.has(id.slice("session:".length))) return true;
      const entry = this.index.entry(id);
      if (
        entry &&
        (this.contexts.has(entry.contextId) || entry.messageIds.some((id) => this.messages.has(id)))
      )
        return true;
    }
    return false;
  };

  contextIds() {
    return new Set(this.contexts);
  }
}
