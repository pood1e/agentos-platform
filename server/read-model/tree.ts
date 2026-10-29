import { TaskState } from "../../gen/a2a_pb.js";
import type { TaskEntry } from "./entry.js";
import type { TaskGraph } from "./graph.js";
import { terminal } from "./state.js";

export interface TaskTree {
  root: TaskEntry;
  entries: TaskEntry[];
  background: Set<string>;
  /** Most recent task of the root agent in the root conversation, including continuations. */
  latest: TaskEntry;
  /** Last status change anywhere in the operation. */
  updatedAt?: number;
}

function children(graph: TaskGraph, entry: TaskEntry): string[] {
  const relations = graph.relations();
  return [...relations.parents.entries()].flatMap(([child, parent]) =>
    parent === entry.id ? [child] : [],
  );
}

function reach(graph: TaskGraph, start: string[]): Set<string> {
  const seen = new Set<string>();
  for (let pending = [...start], id = pending.pop(); id; id = pending.pop()) {
    if (seen.has(id)) continue;
    const entry = graph.entry(id);
    if (!entry) continue;
    seen.add(id);
    pending.push(...children(graph, entry));
  }
  return seen;
}

export function taskTree(graph: TaskGraph, rootId: string): TaskTree | undefined {
  const root = graph.entry(rootId);
  if (!root) return undefined;
  const ids = reach(graph, [rootId]);
  const entries = [...ids].flatMap((id) => graph.entry(id) ?? []);
  const background = reach(
    graph,
    entries.filter((entry) => entry.execution?.background).map((entry) => entry.id),
  );
  const latest =
    entries
      .filter((entry) => entry.agentId === root.agentId && entry.contextId === root.contextId)
      .sort((a, b) => (b.statusAt ?? 0) - (a.statusAt ?? 0))[0] ?? root;
  const times = entries.flatMap((entry) => entry.statusAt ?? []);
  const updatedAt = times.length ? Math.max(...times) : undefined;
  return { root, entries, background, latest, updatedAt };
}

export const foreground = (tree: TaskTree) =>
  tree.entries.filter((entry) => !tree.background.has(entry.id));

export const busy = (tree: TaskTree) => foreground(tree).some((entry) => !terminal(entry.state));

export const outcomeState = (tree: TaskTree) =>
  foreground(tree).some(
    (entry) =>
      entry.state === TaskState.CANCELED && (entry.statusAt ?? 0) >= (tree.latest.statusAt ?? 0),
  )
    ? TaskState.CANCELED
    : tree.latest.state;
