import { TaskState } from "../../gen/a2a_pb.js";
import type { TaskEntry } from "./entry.js";
import type { TaskIndex } from "./index.js";
import { terminal } from "./state.js";
import { waitingDelegations } from "./waiting.js";

export interface TaskTree {
  root: TaskEntry;
  entries: TaskEntry[];
  background: Set<string>;
  /** Most recent task of the root agent in the root conversation, including continuations. */
  latest: TaskEntry;
  pending: boolean;
  /** Last status change anywhere in the operation. */
  updatedAt?: number;
}

function children(index: TaskIndex, entry: TaskEntry): string[] {
  const relations = index.relations();
  return [
    ...entry.calls.flatMap((call) => index.target(entry, call) ?? []),
    ...(relations.continuations.get(entry.id) ?? []),
    ...(relations.reviews.get(entry.id) ?? []),
  ];
}

function reach(index: TaskIndex, start: string[]): Set<string> {
  const seen = new Set<string>();
  for (let pending = [...start], id = pending.pop(); id; id = pending.pop()) {
    if (seen.has(id)) continue;
    const entry = index.entry(id);
    if (!entry) continue;
    seen.add(id);
    pending.push(...children(index, entry));
  }
  return seen;
}

export function taskTree(index: TaskIndex, rootId: string): TaskTree | undefined {
  const root = index.entry(rootId);
  if (!root) return undefined;
  const ids = reach(index, [rootId]);
  const entries = [...ids].flatMap((id) => index.entry(id) ?? []);
  const background = reach(
    index,
    entries.flatMap((entry) =>
      entry.calls.flatMap((call) =>
        call.delegation?.kind === "background" ? (index.target(entry, call) ?? []) : [],
      ),
    ),
  );
  const latest =
    entries
      .filter((entry) => entry.agentId === root.agentId && entry.contextId === root.contextId)
      .sort((a, b) => (b.statusAt ?? 0) - (a.statusAt ?? 0))[0] ?? root;
  const times = entries.flatMap((entry) => entry.statusAt ?? []);
  const updatedAt = times.length ? Math.max(...times) : undefined;
  const resumed = index.relations().resumed;
  const pending = entries.some(
    (entry) =>
      !background.has(entry.id) && waitingDelegations(index, entry).some((id) => !resumed.has(id)),
  );
  return { root, entries, background, latest, updatedAt, pending };
}

export const foreground = (tree: TaskTree) =>
  tree.entries.filter((entry) => !tree.background.has(entry.id));

export const busy = (tree: TaskTree) =>
  (outcomeState(tree) !== TaskState.CANCELED && tree.pending) ||
  foreground(tree).some((entry) => !terminal(entry.state));

export const outcomeState = (tree: TaskTree) =>
  foreground(tree).some(
    (entry) =>
      entry.state === TaskState.CANCELED && (entry.statusAt ?? 0) >= (tree.latest.statusAt ?? 0),
  )
    ? TaskState.CANCELED
    : tree.latest.state;
