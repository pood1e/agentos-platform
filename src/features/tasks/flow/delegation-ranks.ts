import type { CollaborationStep } from "./sequence.js";

/** First participation follows native reply dependencies, independently of clock overlap. */
export function delegationRanks(steps: CollaborationStep[], rootTaskId?: string) {
  const links = new Map(steps.map(({ link }) => [link.id, link]));
  const parents = new Map<string, string>();
  for (const { link } of steps)
    if (link.targetTaskId && link.targetTaskId !== rootTaskId && !parents.has(link.targetTaskId))
      parents.set(link.targetTaskId, link.id);
  const ranks = new Map<string, number>();
  const visiting = new Set<string>();
  const rank = (id: string): number => {
    const known = ranks.get(id);
    if (known !== undefined) return known;
    const link = links.get(id);
    if (!link || visiting.has(id)) return 0;
    visiting.add(id);
    const parent = parents.get(link.sourceTaskId);
    const value =
      Math.max(0, parent ? rank(parent) : 0, ...link.dependsOn.map((id) => rank(id))) + 1;
    visiting.delete(id);
    ranks.set(id, value);
    return value;
  };
  for (const { link } of steps) rank(link.id);
  return ranks;
}
