import {
  AssistantRuntimeProvider,
  MessageNotSentError,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import type { ReactNode } from "react";
import { convertMessage } from "./runtime-message.js";
import { SpeechContext } from "./speech/context.js";
import { useSpeech } from "./speech/use-speech.js";
import type { Chat } from "./use-chat.js";

export function ConversationRuntime({ chat, children }: { chat: Chat; children: ReactNode }) {
  const { adapters, controls } = useSpeech();
  const runtime = useExternalStoreRuntime({
    adapters,
    messages: chat.messages,
    convertMessage,
    isRunning: chat.sending || (chat.busy && !chat.pending.length),
    isDisabled: chat.sending,
    isSendDisabled: chat.blocked,
    onCancel: () => chat.cancel(),
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
