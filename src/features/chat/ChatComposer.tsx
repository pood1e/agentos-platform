import { ComposerPrimitive } from "@assistant-ui/react";
import { ArrowUp, LoaderCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { Chat } from "./use-chat.js";

export function ChatComposer({ chat, builder = false }: { chat: Chat; builder?: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="mx-auto w-full max-w-3xl shrink-0 space-y-2 p-3 sm:p-4">
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
        />
        <ComposerPrimitive.Send asChild>
          <Button
            size="icon-sm"
            aria-label={t(builder ? "configuration.generate" : "chat.send")}
            title={t(builder ? "configuration.generate" : "chat.send")}
            className="self-end rounded-full"
          >
            {chat.sending ? <LoaderCircle className="motion-safe:animate-spin" /> : <ArrowUp />}
          </Button>
        </ComposerPrimitive.Send>
      </ComposerPrimitive.Root>
    </div>
  );
}
