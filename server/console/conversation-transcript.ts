import type { Conversation } from "../../gen/agentos/console/v1/conversation_pb.js";

/** Updates native HITL cards at their original transcript positions. */
export function conversationTranscript(view: Conversation) {
  const interactions = new Map(view.interactions.map((item) => [item.id, item]));
  for (const message of view.messages)
    message.parts = message.parts.flatMap((part) => {
      if (part.content.case !== "interaction") return [part];
      const interaction = interactions.get(part.content.value.id);
      if (!interaction) return [];
      part.content = { case: "interaction", value: interaction };
      return [part];
    });
  return view;
}
