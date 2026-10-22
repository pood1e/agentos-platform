import { RoomAudioRenderer, RoomContext, StartAudio } from "@livekit/components-react";
import { Mic, MicOff, Phone, PhoneOff, RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import type { VoiceCall } from "./use-voice-call.js";

export function VoiceCallControls({ call, disabled }: { call: VoiceCall; disabled: boolean }) {
  const { t } = useTranslation();
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
              {t(
                call.muted
                  ? "speech.callMuted"
                  : call.queue.count
                    ? "speech.callWaiting"
                    : `speech.call_${call.phase}`,
              )}
            </p>
            {call.draft && (
              <p dir="auto" className="mt-1 truncate text-xs text-muted-foreground">
                {call.draft}
              </p>
            )}
          </div>
          {call.queue.failed && (
            <Button size="sm" variant="outline" onClick={call.retry}>
              <RotateCcw />
              {t("speech.callRetry")}
            </Button>
          )}
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
      {!call.active && call.unsent && (
        <p className="whitespace-pre-wrap text-xs text-muted-foreground" dir="auto">
          {t("speech.callUnsent")} {call.unsent}
        </p>
      )}
    </div>
  );
}
