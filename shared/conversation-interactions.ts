import type { Conversation } from "../gen/agentos/console/v1/conversation_pb.js";
import { ActivityState } from "../gen/agentos/execution/v1/state_pb.js";

export function pendingInteractions(view: Pick<Conversation, "interactions" | "runs"> | undefined) {
  const background = new Set(view?.runs.filter((run) => run.background).map((run) => run.taskId));
  return (
    view?.interactions.filter(
      (item) =>
        !background.has(item.taskId) &&
        (item.state === ActivityState.AWAITING_APPROVAL ||
          item.state === ActivityState.AWAITING_INPUT),
    ) ?? []
  );
}
