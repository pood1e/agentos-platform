import { DelegationKind } from "../../gen/agentos/console/v1/task_pb.js";
import { type AgentInfo, type SessionInfo, systemRoles } from "./agents.js";
import type { CallEntry } from "./calls.js";
import type { TaskEntry } from "./entry.js";

export type ChangeListener = (changed: ReadonlySet<string>) => void;

export interface Relations {
  /** Child task per `${taskId}:${callId}` delegation call. */
  targets: Map<string, string>;
  parents: Map<string, string>;
  /** Explicit task references and delegation calls, excluding chronological session grouping. */
  causalParents: Map<string, string>;
  continuations: Map<string, string[]>;
  reviews: Map<string, string[]>;
  resumed: Set<string>;
  roots: TaskEntry[];
}

const callKey = (taskId: string, callId: string) => `${taskId}:${callId}`;

/** In-memory read model of the caller's kagent tasks, sessions and agents. */
export class TaskIndex {
  private entries = new Map<string, TaskEntry>();
  private contexts = new Map<string, Set<string>>();
  private byAgent = new Map<string, Set<string>>();
  private missingSessions = new Set<string>();
  private messages = new Map<string, string>();
  private sessionInfo = new Map<string, SessionInfo>();
  private agentInfo = new Map<string, AgentInfo>();
  private listeners = new Set<ChangeListener>();
  private changed = new Set<string>();
  private cache?: Relations;
  private revisionCount = 0;

  get revision() {
    return this.revisionCount;
  }

  upsert(entry: TaskEntry): boolean {
    const previous = this.entries.get(entry.id);
    if (previous?.version === entry.version && previous.agentId === entry.agentId) return false;
    this.entries.set(entry.id, entry);
    if (previous?.contextId !== entry.contextId)
      this.contexts.get(previous?.contextId ?? "")?.delete(entry.id);
    if (previous?.agentId !== entry.agentId)
      this.byAgent.get(previous?.agentId ?? "")?.delete(entry.id);
    const context = this.contexts.get(entry.contextId) ?? new Set();
    this.contexts.set(entry.contextId, context.add(entry.id));
    const agent = this.byAgent.get(entry.agentId) ?? new Set();
    this.byAgent.set(entry.agentId, agent.add(entry.id));
    for (const id of [entry.contextId, ...entry.calls.map((call) => call.delegation?.sessionId)])
      if (id && !this.sessionInfo.has(id)) this.missingSessions.add(id);
    for (const id of entry.messageIds) this.messages.set(id, entry.id);
    this.touch(entry.id);
    return true;
  }

  setAgents(agents: AgentInfo[]): void {
    const next = new Map(agents.map((agent) => [agent.id, agent]));
    if (JSON.stringify([...next]) === JSON.stringify([...this.agentInfo])) return;
    this.agentInfo = next;
    this.touch("");
  }

  setSession(session: SessionInfo): void {
    const previous = this.sessionInfo.get(session.id);
    if (previous && JSON.stringify(previous) === JSON.stringify(session)) return;
    this.sessionInfo.set(session.id, session);
    this.missingSessions.delete(session.id);
    this.touch("");
  }

  entry = (id: string) => this.entries.get(id);
  session = (id: string) => this.sessionInfo.get(id);
  agent = (id: string) => this.agentInfo.get(id);
  agents = () => [...this.agentInfo.values()];
  sessions = () => [...this.sessionInfo.values()];
  all = () => [...this.entries.values()];
  unknownSessions = () => [...this.missingSessions];

  agentEntries(agentId: string): TaskEntry[] {
    return [...(this.byAgent.get(agentId) ?? [])].flatMap((id) => this.entries.get(id) ?? []);
  }

  taskOfMessage = (messageId: string) => this.entries.get(this.messages.get(messageId) ?? "");

  contextEntries(contextId: string): TaskEntry[] {
    return [...(this.contexts.get(contextId) ?? [])].flatMap((id) => this.entries.get(id) ?? []);
  }

  roleOf = (agentId: string) => this.agentInfo.get(agentId)?.role ?? "";

  onChange(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Notifies listeners once per batch of updates. */
  flush(): void {
    if (!this.changed.size) return;
    const changed = this.changed;
    this.changed = new Set();
    for (const listener of this.listeners) listener(changed);
  }

  target(entry: TaskEntry, call: CallEntry): string | undefined {
    return this.relations().targets.get(callKey(entry.id, call.id));
  }

  operationRoot(id: string): TaskEntry | undefined {
    let entry = this.entry(id);
    const seen = new Set<string>();
    while (entry && !seen.has(entry.id)) {
      seen.add(entry.id);
      const parent = this.entry(this.relations().parents.get(entry.id) ?? "");
      if (!parent || systemRoles.has(this.roleOf(parent.agentId))) return entry;
      entry = parent;
    }
    return undefined;
  }

  relations(): Relations {
    this.cache ??= this.build();
    return this.cache;
  }

  private touch(id: string) {
    this.changed.add(id);
    this.cache = undefined;
    this.revisionCount++;
  }

  private resolve(call: CallEntry): string | undefined {
    const ref = call.delegation;
    if (!ref || ref.kind === DelegationKind.HANDOFF) return undefined;
    if (!ref.sessionId && ref.agentName && ref.messageId) {
      const id = this.messages.get(ref.messageId);
      const target = id && this.entries.get(id);
      return target && this.roleOf(target.agentId) === ref.agentName ? id : undefined;
    }
    const owner = this.session(ref.sessionId)?.agentId;
    const candidates = new Set(
      [...(this.contexts.get(ref.sessionId) ?? [])].filter(
        (id) => !owner || this.entry(id)?.agentId === owner,
      ),
    );
    if (!candidates?.size) return undefined;
    if (ref.taskId) return candidates.has(ref.taskId) ? ref.taskId : undefined;
    if (ref.messageId) {
      const id = this.messages.get(ref.messageId);
      return id && candidates.has(id) ? id : undefined;
    }
    if (ref.message) {
      const matches = [...candidates].filter((id) => {
        const entry = this.entries.get(id);
        return (
          entry !== undefined &&
          entry.prompt === ref.message &&
          (call.startedAt === undefined ||
            (entry.createdAt !== undefined && entry.createdAt >= call.startedAt))
        );
      });
      return matches.length === 1 ? matches[0] : undefined;
    }
    return candidates.size === 1 ? [...candidates][0] : undefined;
  }

  private build(): Relations {
    const targets = new Map<string, string>();
    const parents = new Map<string, string>();
    const continuations = new Map<string, string[]>();
    const reviews = new Map<string, string[]>();
    const resumed = new Set<string>();
    const operational = new Set<string>();
    for (const entry of this.entries.values()) {
      const operation = !systemRoles.has(this.roleOf(entry.agentId));
      for (const call of entry.calls) {
        const child = this.resolve(call);
        if (!child) continue;
        targets.set(callKey(entry.id, call.id), child);
        if (!parents.has(child)) parents.set(child, entry.id);
        if (operation) operational.add(child);
      }
      if (entry.parentTaskId) {
        continuations.set(entry.parentTaskId, [
          ...(continuations.get(entry.parentTaskId) ?? []),
          entry.id,
        ]);
        parents.set(entry.id, entry.parentTaskId);
      }
      if (entry.resumedTaskId) resumed.add(entry.resumedTaskId);
      if (entry.reviewOfTaskId) {
        reviews.set(entry.reviewOfTaskId, [...(reviews.get(entry.reviewOfTaskId) ?? []), entry.id]);
        parents.set(entry.id, entry.reviewOfTaskId);
      }
    }
    const causalParents = new Map(parents);
    for (const ids of this.contexts.values()) {
      const rounds = [...ids]
        .flatMap((id) => this.entry(id) ?? [])
        .filter((entry) => this.agent(entry.agentId)?.sessionTasks)
        .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0) || a.id.localeCompare(b.id));
      for (let position = 1; position < rounds.length; position++) {
        const entry = rounds[position];
        const previous = rounds[position - 1];
        if (!entry || !previous || entry.parentTaskId || entry.reviewOfTaskId) continue;
        continuations.set(previous.id, [...(continuations.get(previous.id) ?? []), entry.id]);
        parents.set(entry.id, previous.id);
        operational.add(entry.id);
      }
    }
    const roots = [...this.entries.values()].filter(
      (entry) =>
        !systemRoles.has(this.roleOf(entry.agentId)) &&
        !entry.reviewOfTaskId &&
        !operational.has(entry.id) &&
        !entry.parentTaskId,
    );
    return { targets, parents, causalParents, continuations, reviews, resumed, roots };
  }
}
