import {
  AssistantRuntimeProvider,
  MessageNotSentError,
  type ThreadMessageLike,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import type { ReactNode } from "react";
import { Role } from "../../../gen/a2a_pb.js";
import type { ChatMessage } from "../../../gen/agentos/console/v1/conversation_pb.js";
import { SpeechContext } from "./speech/context.js";
import { useSpeech } from "./speech/use-speech.js";
import type { Chat } from "./use-chat.js";

const convertMessage = (message: ChatMessage): ThreadMessageLike => ({
  id: message.id,
  role: message.role === Role.USER ? "user" : "assistant",
  content: [{ type: "text", text: message.text }],
});

export function ConversationRuntime({ chat, children }: { chat: Chat; children: ReactNode }) {
  const { adapters, controls } = useSpeech();
  const runtime = useExternalStoreRuntime({
    adapters,
    messages: chat.messages,
    convertMessage,
    isRunning: chat.sending || (chat.busy && !chat.pending.length),
    isDisabled: chat.sending,
    isSendDisabled: chat.blocked,
    onNew: async (message) => {
      const text = message.content
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("\n");
      if (!(await chat.submit(text))) throw new MessageNotSentError();
    },
  });
  return (
    <SpeechContext value={controls}>
      <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>
    </SpeechContext>
  );
}
