import { ActionBarPrimitive, AuiIf, ComposerPrimitive } from "@assistant-ui/react";
import { Mic, Square, Volume2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";

export function SpeechInput({ disabled }: { disabled: boolean }) {
  const { t } = useTranslation();
  return (
    <AuiIf condition={(state) => state.thread.capabilities.dictation}>
      <AuiIf condition={(state) => state.composer.dictation == null}>
        <ComposerPrimitive.Dictate asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            disabled={disabled}
            aria-label={t("speech.record")}
            title={t("speech.record")}
          >
            <Mic />
          </Button>
        </ComposerPrimitive.Dictate>
      </AuiIf>
      <AuiIf condition={(state) => state.composer.dictation != null}>
        <ComposerPrimitive.StopDictation asChild>
          <Button
            variant="destructive"
            size="icon-sm"
            aria-label={t("speech.stopRecording")}
            title={t("speech.stopRecording")}
          >
            <Square />
          </Button>
        </ComposerPrimitive.StopDictation>
      </AuiIf>
    </AuiIf>
  );
}

export function SpeechOutput() {
  const { t } = useTranslation();
  return (
    <AuiIf condition={(state) => state.thread.capabilities.speech}>
      <ActionBarPrimitive.Root className="mt-1 flex gap-1">
        <AuiIf condition={(state) => state.message.speech == null}>
          <ActionBarPrimitive.Speak asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("speech.play")}
              title={t("speech.play")}
            >
              <Volume2 />
            </Button>
          </ActionBarPrimitive.Speak>
        </AuiIf>
        <AuiIf condition={(state) => state.message.speech != null}>
          <ActionBarPrimitive.StopSpeaking asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("speech.stopPlayback")}
              title={t("speech.stopPlayback")}
            >
              <Square />
            </Button>
          </ActionBarPrimitive.StopSpeaking>
        </AuiIf>
      </ActionBarPrimitive.Root>
    </AuiIf>
  );
}
