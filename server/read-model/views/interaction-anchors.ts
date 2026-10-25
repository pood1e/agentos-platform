import { millis } from "../decode/messages.js";
import type { TaskEntry } from "../entry.js";
import type { TaskIndex } from "../index.js";
import { taskTree } from "../tree.js";

/** A reused worker session can be delegated again by a later conversation turn. */
export function interactionAnchors(index: TaskIndex, entries: TaskEntry[]) {
  const anchors = new Map<string, { entryId: string; callId: string; at: number }>();
  for (const entry of entries)
    for (const call of entry.calls) {
      const target = index.target(entry, call);
      const children = target ? (taskTree(index, target)?.entries ?? []) : [];
      const at = call.startedAt ?? entry.createdAt ?? 0;
      for (const child of children) {
        if (child.contextId === entry.contextId) continue;
        for (const interaction of child.interactions) {
          const requested = millis(interaction.requestedAt) ?? child.createdAt;
          if (requested !== undefined && at > requested) continue;
          const previous = anchors.get(interaction.id);
          if (!previous || at > previous.at)
            anchors.set(interaction.id, { entryId: entry.id, callId: call.id, at });
        }
      }
    }
  return anchors;
}
