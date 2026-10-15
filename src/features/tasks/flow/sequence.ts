import { type Link, running } from "./links.js";

type Milestone = "finished" | "returned";

export interface CollaborationStep {
  link: Link;
  order?: number;
  occurrence: number;
  simultaneous: string[];
  parallel: string[];
}

function descendantsOf(link: Link, children: Map<string, string[]>): Set<string> {
  const descendants = new Set<string>();
  const pending =
    link.targetTaskId && link.targetTaskId !== link.sourceTaskId ? [link.targetTaskId] : [];
  for (let task = pending.pop(); task; task = pending.pop()) {
    if (descendants.has(task)) continue;
    descendants.add(task);
    pending.push(...(children.get(task) ?? []));
  }
  return descendants;
}

export function eventTime(link: Link, point: Milestone): number | undefined {
  const at = point === "finished" ? link.finishedAt : link.endedAt;
  return at !== undefined && (link.startedAt === undefined || at >= link.startedAt)
    ? at
    : undefined;
}

export function sequenceFor(links: Link[], observedAt?: number): CollaborationStep[] {
  const ordered = [...links].sort(
    (a, b) => (a.startedAt ?? Infinity) - (b.startedAt ?? Infinity) || a.id.localeCompare(b.id),
  );
  const children = new Map<string, string[]>();
  for (const link of links) {
    if (link.targetTaskId && link.targetTaskId !== link.sourceTaskId)
      children.set(link.sourceTaskId, [
        ...(children.get(link.sourceTaskId) ?? []),
        link.targetTaskId,
      ]);
  }
  const descendants = new Map(ordered.map((link) => [link.id, descendantsOf(link, children)]));
  return ordered.map((link, index) => {
    const siblings = ordered.filter(
      (other) =>
        other.id !== link.id &&
        Boolean(link.sourceTaskId && other.sourceTaskId) &&
        (link.sourceTaskId === other.sourceTaskId ||
          Boolean(link.targetTaskId && other.targetTaskId)) &&
        !descendants.get(link.id)?.has(other.sourceTaskId) &&
        !descendants.get(other.id)?.has(link.sourceTaskId),
    );
    const end =
      eventTime(link, "finished") ??
      eventTime(link, "returned") ??
      (running(link.state) ? observedAt : undefined);
    return {
      link,
      order: link.startedAt === undefined ? undefined : index + 1,
      occurrence:
        link.startedAt === undefined
          ? 1
          : ordered
              .slice(0, index)
              .filter((other) => other.source === link.source && other.target === link.target)
              .length + 1,
      simultaneous: siblings
        .filter((other) => link.startedAt !== undefined && link.startedAt === other.startedAt)
        .map((other) => other.id),
      parallel: siblings
        .filter((other) => {
          const otherEnd =
            eventTime(other, "finished") ??
            eventTime(other, "returned") ??
            (running(other.state) ? observedAt : undefined);
          return (
            link.startedAt !== undefined &&
            other.startedAt !== undefined &&
            end !== undefined &&
            otherEnd !== undefined &&
            Math.max(link.startedAt, other.startedAt) < Math.min(end, otherEnd)
          );
        })
        .map((other) => other.id),
    };
  });
}
