import { RoomAudioRenderer, RoomContext, StartAudio } from "@livekit/components-react";
import { Mic, MicOff, Phone, PhoneOff } from "lucide-react";
import { useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useVoiceCall } from "../../../../shared/browser/voice/use-voice-call.js";
import { useAccess } from "../../../lib/access.js";
import { consoleClient } from "../../../lib/console.js";
import { useSpeechCapabilities } from "../../../lib/speech.js";

export function VoiceCallControls({
  contextId,
  disabled,
  onActive,
  onStarted,
}: {
  contextId: string;
  disabled: boolean;
  onActive: (active: boolean) => void;
  onStarted: (contextId: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const access = useAccess();
  const capabilities = useSpeechCapabilities();
  const report = useCallback((key: string) => void toast.error(t(key)), [t]);
  const call = useVoiceCall({
    client: consoleClient,
    contextId,
    scope: JSON.stringify([access.data?.workspace, access.data?.subject]),
    language: localStorage.getItem("speech-language") ?? i18n.resolvedLanguage?.split("-")[0] ?? "",
    capabilities: capabilities.data,
    report,
    started: onStarted,
  });
  useEffect(() => onActive(call.active), [call.active, onActive]);
  if (!call.available && !call.active) return null;
  return (
    <div className="shrink-0 space-y-2 px-3 pb-2 sm:px-4">
      {call.room && (
        <RoomContext.Provider value={call.room}>
          <RoomAudioRenderer />
          <StartAudio label={t("speech.callEnableAudio")} className="text-xs underline" />
        </RoomContext.Provider>
      )}
      {call.active ? (
        <div
          className="flex items-center gap-2 rounded-xl border bg-muted/40 px-3 py-2"
          data-testid="voice-call"
        >
          <div className="min-w-0 flex-1">
            <p role="status" className="text-xs font-medium">
              {t(call.muted ? "speech.callMuted" : `speech.call_${call.phase}`)}
            </p>
            {call.draft && (
              <p dir="auto" className="mt-1 truncate text-xs text-muted-foreground">
                {call.draft}
              </p>
            )}
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            disabled={call.phase === "connecting"}
            onClick={call.toggleMute}
            aria-label={t(call.muted ? "speech.callUnmute" : "speech.callMute")}
          >
            {call.muted ? <MicOff /> : <Mic />}
          </Button>
          <Button
            variant="destructive"
            size="icon-sm"
            onClick={call.stop}
            aria-label={t("speech.callEnd")}
          >
            <PhoneOff />
          </Button>
        </div>
      ) : (
        <Button size="sm" variant="outline" disabled={disabled} onClick={() => void call.start()}>
          <Phone />
          {t("speech.callStart")}
        </Button>
      )}
    </div>
  );
}
