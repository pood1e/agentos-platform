import { ComposerPrimitive, useAuiState } from "@assistant-ui/react";
import { ArrowUp, LoaderCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useAccess } from "../../lib/access.js";
import { StopTask } from "../tasks/StopTask.js";
import { SpeechInput } from "./speech/SpeechControls.js";
import type { Chat } from "./use-chat.js";

export function ChatComposer({ chat, builder = false }: { chat: Chat; builder?: boolean }) {
  const { t } = useTranslation();
  const access = useAccess();
  const dictating = useAuiState((state) => state.composer.dictation != null);
  if (!access.data) return null;
  if (chat.conversation && !chat.conversation.operate)
    return (
      <div className="mx-auto w-full max-w-3xl shrink-0 p-3 sm:p-4">
        <Alert>
          <AlertDescription>{t("access.readOnly")}</AlertDescription>
        </Alert>
      </div>
    );
  return (
    <div className="mx-auto w-full max-w-3xl shrink-0 space-y-2 p-3 sm:p-4">
      {!builder && !access.data.write && (
        <p className="text-xs text-muted-foreground">{t("access.readOnlyTools")}</p>
      )}
      {chat.error && (
        <Alert variant="destructive">
          <AlertDescription>{t(chat.error)}</AlertDescription>
        </Alert>
      )}
      {chat.conversation && !chat.ready && (
        <p className="text-xs text-muted-foreground">{t("chat.notReady")}</p>
      )}
      <ComposerPrimitive.Root className="flex w-full flex-col gap-2 rounded-2xl border bg-card p-2 shadow-xs focus-within:border-ring">
        <ComposerPrimitive.Input
          aria-label={t(builder ? "configuration.requirement" : "chat.message")}
          placeholder={t(builder ? "configuration.builderPlaceholder" : "chat.placeholder")}
          maxLength={8000}
          rows={2}
          className="max-h-40 min-h-12 w-full resize-none bg-transparent px-2 py-1 text-sm leading-6 outline-none placeholder:text-muted-foreground"
          enterKeyHint="send"
          cancelOnEscape={false}
          addAttachmentOnPaste={false}
          dir="auto"
        />
        <div className="flex items-center justify-end gap-2">
          <SpeechInput disabled={chat.blocked || chat.sending || chat.busy} />
          {chat.busy && chat.conversation?.messages.at(-1)?.taskId ? (
            <div className="self-end">
              <StopTask
                taskId={chat.conversation.messages.at(-1)?.taskId ?? ""}
                operate={chat.conversation.operate}
              />
            </div>
          ) : (
            <ComposerPrimitive.Send asChild>
              <Button
                size="icon-sm"
                aria-label={t(builder ? "configuration.generate" : "chat.send")}
                title={t(builder ? "configuration.generate" : "chat.send")}
                className="self-end rounded-full"
                disabled={dictating}
              >
                {chat.sending ? <LoaderCircle className="motion-safe:animate-spin" /> : <ArrowUp />}
              </Button>
            </ComposerPrimitive.Send>
          )}
        </div>
      </ComposerPrimitive.Root>
    </div>
  );
}
