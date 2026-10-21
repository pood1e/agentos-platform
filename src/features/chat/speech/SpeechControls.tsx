import { ActionBarPrimitive, AuiIf, ComposerPrimitive } from "@assistant-ui/react";
import { LoaderCircle, Mic, Square, Volume2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useSpeechControls } from "./context.js";
import { speechText } from "./text.js";

export function SpeechInput({ disabled }: { disabled: boolean }) {
  const { t, i18n } = useTranslation();
  const controls = useSpeechControls();
  const phase = controls?.phase ?? "idle";
  const busy = phase === "starting" || phase === "processing";
  const names = new Intl.DisplayNames([i18n.resolvedLanguage ?? "en"], { type: "language" });
  return (
    <AuiIf condition={(state) => state.thread.capabilities.dictation}>
      {controls && controls.languages.length > 0 && (
        <Select
          value={controls.language || "auto"}
          onValueChange={(language) => controls.setLanguage(language === "auto" ? "" : language)}
          disabled={disabled || phase !== "idle"}
        >
          <SelectTrigger size="sm" aria-label={t("speech.language")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="auto">{t("speech.autoLanguage")}</SelectItem>
            {controls.languages.map((language) => (
              <SelectItem key={language} value={language}>
                {names.of(language) ?? language}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {phase !== "idle" && (
        <span role="status" className="text-xs text-muted-foreground">
          {t(`speech.${phase}`)}
        </span>
      )}
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
        {busy ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={controls?.cancel}
            aria-label={t("speech.cancel")}
          >
            <LoaderCircle className="motion-safe:animate-spin" />
            {t("speech.cancel")}
          </Button>
        ) : (
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
        )}
      </AuiIf>
    </AuiIf>
  );
}

export function SpeechOutput() {
  const { t } = useTranslation();
  return (
    <AuiIf
      condition={(state) =>
        state.thread.capabilities.speech &&
        state.message.content.some((part) => part.type === "text" && !!speechText(part.text))
      }
    >
      <ActionBarPrimitive.Root className="mt-1 flex items-center gap-1">
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
          <AuiIf condition={(state) => state.message.speech?.status.type === "starting"}>
            <LoaderCircle className="size-4 motion-safe:animate-spin" />
            <span role="status" className="text-xs text-muted-foreground">
              {t("speech.generating")}
            </span>
          </AuiIf>
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
