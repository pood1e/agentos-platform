import { useQuery } from "@connectrpc/connect-query";
import { useCallback, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ConsoleService } from "../../../../gen/agentos/console/v1/console_service_pb.js";
import { speechClient } from "../../../lib/console.js";
import { RemoteDictationAdapter } from "./dictation.js";
import { RemoteSpeechAdapter } from "./synthesis.js";

export function useSpeech() {
  const { t } = useTranslation();
  const capabilities = useQuery(
    ConsoleService.method.getSpeechCapabilities,
    {},
    { staleTime: 60_000 },
  );
  const onError = useCallback((key: string) => void toast.error(t(key)), [t]);
  const transcription = capabilities.data?.transcription === true;
  const synthesis = capabilities.data?.synthesis === true;
  const adapters = useMemo(
    () => ({
      dictation:
        transcription && RemoteDictationAdapter.isSupported()
          ? new RemoteDictationAdapter(speechClient, onError)
          : undefined,
      speech: synthesis ? new RemoteSpeechAdapter(speechClient, onError) : undefined,
    }),
    [transcription, synthesis, onError],
  );
  useEffect(
    () => () => {
      adapters.dictation?.dispose();
      adapters.speech?.dispose();
    },
    [adapters],
  );
  return adapters;
}
