import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type { DictationPhase } from "../../../../shared/browser/voice/dictation.js";
import { consoleClient } from "../../../lib/console.js";
import { useSpeechCapabilities } from "../../../lib/speech.js";
import { useVoiceCallActive } from "../voice/context.js";

// LiveKit loads only for deployments with voice.
const loadVoice = () =>
  Promise.all([
    import("../../../../shared/browser/voice/dictation.js"),
    import("../../../../shared/browser/voice/speech.js"),
  ]);

export function useSpeech() {
  const { t, i18n } = useTranslation();
  const [phase, setPhase] = useState<DictationPhase>("idle");
  const calling = useVoiceCallActive();
  const [selected, setSelected] = useState(() => localStorage.getItem("speech-language"));
  const [voice, setVoice] = useState<Awaited<ReturnType<typeof loadVoice>>>();
  const capabilities = useSpeechCapabilities();
  const enabled = capabilities.data?.enabled === true;
  useEffect(() => {
    if (enabled) void loadVoice().then(setVoice);
  }, [enabled]);
  const onError = useCallback((key: string) => void toast.error(t(key)), [t]);
  const transcription = !calling && capabilities.data?.transcription === true;
  const synthesis = !calling && capabilities.data?.synthesis === true;
  const languages = capabilities.data?.transcriptionLanguages ?? [];
  const preferred = i18n.resolvedLanguage?.split("-")[0] ?? "";
  const language =
    selected === ""
      ? ""
      : languages.includes(selected ?? "")
        ? (selected ?? "")
        : languages.includes(preferred)
          ? preferred
          : "";
  const adapters = useMemo(() => {
    if (!voice) return {};
    const [{ VoiceDictationAdapter }, { VoiceSpeechAdapter }] = voice;
    const speech = synthesis
      ? new VoiceSpeechAdapter(consoleClient, onError, () => dictation?.dispose())
      : undefined;
    const dictation =
      transcription && VoiceDictationAdapter.isSupported()
        ? new VoiceDictationAdapter(consoleClient, onError, {
            language,
            onPhase: (next) => {
              if (next === "starting") speech?.dispose();
              setPhase(next);
            },
          })
        : undefined;
    return { dictation, speech };
  }, [voice, transcription, synthesis, onError, language]);
  useEffect(
    () => () => {
      adapters.dictation?.dispose();
      adapters.speech?.dispose();
    },
    [adapters],
  );
  return {
    adapters,
    controls: {
      phase,
      language,
      languages,
      setLanguage: (value: string) => {
        localStorage.setItem("speech-language", value);
        setSelected(value);
      },
      cancel: () => adapters.dictation?.dispose(),
    },
  };
}
