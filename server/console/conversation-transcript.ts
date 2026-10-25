import type { Conversation } from "../../gen/agentos/console/v1/conversation_pb.js";
import type { Interaction } from "../../gen/agentos/console/v1/task_pb.js";
import { ActivityState } from "../../gen/agentos/execution/v1/state_pb.js";

function visible(interaction: Interaction) {
  if (!interaction.external) return true;
  if (interaction.state === ActivityState.REJECTED) return interaction.approvals.length > 0;
  if (interaction.state !== ActivityState.FAILED) return true;
  return interaction.approvals.some(
    (record) =>
      record.app ||
      record.link ||
      record.description ||
      record.decidedBy ||
      record.state !== ActivityState.FAILED,
  );
}

/** Bind enriched review records to their original transcript positions. */
export function conversationTranscript(view: Conversation) {
  const interactions = new Map(view.interactions.map((item) => [item.id, item]));
  for (const message of view.messages)
    message.parts = message.parts.flatMap((part) => {
      if (part.content.case !== "interaction") return [part];
      const interaction = interactions.get(part.content.value.id);
      if (!interaction || !visible(interaction)) return [];
      part.content = { case: "interaction", value: interaction };
      return [part];
    });
  return view;
}
