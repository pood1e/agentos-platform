import { type AgentInfo, type SessionInfo, systemRoles } from "./agents.js";
import type { CallEntry } from "./calls.js";
import type { TaskEntry } from "./entry.js";

export interface Relations {
  /** Child task per `${taskId}:${callId}` delegation call. */
  targets: Map<string, string>;
  parents: Map<string, string>;
  /** Explicit task references and delegation calls, excluding chronological session grouping. */
  causalParents: Map<string, string>;
  continuations: Map<string, string[]>;
  resumed: Set<string>;
  roots: TaskEntry[];
}

const callKey = (taskId: string, callId: string) => `${taskId}:${callId}`;

function group(entries: TaskEntry[], key: (entry: TaskEntry) => string) {
  const groups = new Map<string, TaskEntry[]>();
  for (const entry of entries) groups.set(key(entry), [...(groups.get(key(entry)) ?? []), entry]);
  return groups;
}

/** Immutable view over one execution tree; delegation targets resolve only by task or message ID. */
export class TaskGraph {
  private entries: Map<string, TaskEntry>;
  private contexts: Map<string, TaskEntry[]>;
  private byAgent: Map<string, TaskEntry[]>;
  private messages = new Map<string, string>();
  private sessionInfo: Map<string, SessionInfo>;
  private agentInfo: Map<string, AgentInfo>;
  private cache?: Relations;

  constructor(entries: TaskEntry[] = [], sessions: SessionInfo[] = [], agents: AgentInfo[] = []) {
    this.entries = new Map(entries.map((entry) => [entry.id, entry]));
    this.contexts = group(entries, (entry) => entry.contextId);
    this.byAgent = group(entries, (entry) => entry.agentId);
    for (const entry of entries) for (const id of entry.messageIds) this.messages.set(id, entry.id);
    this.sessionInfo = new Map(sessions.map((session) => [session.id, session]));
    this.agentInfo = new Map(agents.map((agent) => [agent.id, agent]));
  }

  entry = (id: string) => this.entries.get(id);
  session = (id: string) => this.sessionInfo.get(id);
  agent = (id: string) => this.agentInfo.get(id);
  agents = () => [...this.agentInfo.values()];
  sessions = () => [...this.sessionInfo.values()];
  all = () => [...this.entries.values()];
  contextEntries = (contextId: string) => this.contexts.get(contextId) ?? [];
  agentEntries = (agentId: string) => this.byAgent.get(agentId) ?? [];
  taskOfMessage = (messageId: string) => this.entries.get(this.messages.get(messageId) ?? "");
  roleOf = (agentId: string) => this.agentInfo.get(agentId)?.role ?? "";

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

  private resolve(call: CallEntry): string | undefined {
    const ref = call.delegation;
    if (!ref || ref.kind === "handoff") return undefined;
    const target =
      (ref.taskId ? this.entries.get(ref.taskId) : undefined) ??
      (ref.messageId ? this.taskOfMessage(ref.messageId) : undefined);
    if (!target || (ref.sessionId && target.contextId !== ref.sessionId)) return undefined;
    const owner = this.session(target.contextId)?.agentId;
    return !owner || owner === target.agentId ? target.id : undefined;
  }

  private build(): Relations {
    const targets = new Map<string, string>();
    const parents = new Map<string, string>();
    const continuations = new Map<string, string[]>();
    const resumed = new Set<string>();
    const operational = new Set<string>();
    const append = (map: Map<string, string[]>, key: string, id: string) =>
      map.set(key, [...(map.get(key) ?? []), id]);
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
        append(continuations, entry.parentTaskId, entry.id);
        parents.set(entry.id, entry.parentTaskId);
      }
      if (entry.resumedTaskId) resumed.add(entry.resumedTaskId);
    }
    const causalParents = new Map(parents);
    for (const entries of this.contexts.values()) {
      const rounds = entries
        .filter((entry) => this.agent(entry.agentId)?.sessionTasks)
        .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0) || a.id.localeCompare(b.id));
      for (let position = 1; position < rounds.length; position++) {
        const entry = rounds[position];
        const previous = rounds[position - 1];
        if (!entry || !previous || entry.parentTaskId) continue;
        append(continuations, previous.id, entry.id);
        parents.set(entry.id, previous.id);
        operational.add(entry.id);
      }
    }
    const roots = [...this.entries.values()].filter(
      (entry) =>
        !systemRoles.has(this.roleOf(entry.agentId)) &&
        !operational.has(entry.id) &&
        !entry.parentTaskId,
    );
    return { targets, parents, causalParents, continuations, resumed, roots };
  }
}
