import { create } from "@bufbuild/protobuf";
import { DelegationKind, DelegationSchema } from "../../../gen/agentos/console/v1/task_pb.js";
import { terminal } from "../state.js";
import type { TaskTree } from "../tree.js";
import { runState, stamp } from "./runs.js";

/** Correlates independent native reviews with the exact paused tool request. */
export function reviewDelegations(tree: TaskTree) {
  const entries = new Map(tree.entries.map((entry) => [entry.id, entry]));
  return tree.entries.flatMap((review) => {
    const source = entries.get(review.reviewOfTaskId ?? "");
    const interaction = source?.interactions.find(
      (item) => item.requestId === review.reviewRequestId,
    );
    if (!source || !interaction) return [];
    return [
      create(DelegationSchema, {
        id: `review:${review.id}`,
        kind: DelegationKind.REVIEW,
        sourceAgentId: source.agentId,
        targetAgentId: review.agentId,
        sourceTaskId: source.id,
        targetTaskId: review.id,
        sourceContextId: source.contextId,
        targetContextId: review.contextId,
        requestId: interaction.requestId,
        state: runState(review),
        startedAt: stamp(review.createdAt),
        finishedAt: terminal(review.state) ? stamp(review.statusAt) : undefined,
      }),
    ];
  });
}
