import { useQuery } from "@connectrpc/connect-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ConsoleService } from "../../../../gen/agentos/console/v1/console_service_pb.js";
import { speechClient } from "../../../lib/console.js";
import { type DictationPhase, RemoteDictationAdapter } from "./dictation.js";
import { RemoteSpeechAdapter } from "./synthesis.js";

export function useSpeech() {
  const { t, i18n } = useTranslation();
  const [phase, setPhase] = useState<DictationPhase>("idle");
  const [selected, setSelected] = useState(() => localStorage.getItem("speech-language"));
  const capabilities = useQuery(
    ConsoleService.method.getSpeechCapabilities,
    {},
    { staleTime: 60_000 },
  );
  const onError = useCallback((key: string) => void toast.error(t(key)), [t]);
  const transcription = capabilities.data?.transcription === true;
  const synthesis = capabilities.data?.synthesis === true;
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
    const speech = synthesis
      ? new RemoteSpeechAdapter(speechClient, onError, () => dictation?.dispose())
      : undefined;
    const dictation =
      transcription && RemoteDictationAdapter.isSupported()
        ? new RemoteDictationAdapter(onError, undefined, {
            language,
            onPhase: (next) => {
              if (next === "starting") speech?.dispose();
              setPhase(next);
            },
          })
        : undefined;
    return { dictation, speech };
  }, [transcription, synthesis, onError, language]);
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
