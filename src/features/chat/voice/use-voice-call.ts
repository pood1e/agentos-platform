import { useQuery } from "@connectrpc/connect-query";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ConsoleService } from "../../../../gen/agentos/console/v1/console_service_pb.js";
import { useVoiceCall as useBrowserVoiceCall } from "../../../../shared/browser/voice/use-voice-call.js";
import { useAccess } from "../../../lib/access.js";
import { consoleClient } from "../../../lib/console.js";
import type { Chat } from "../use-chat.js";

export function useVoiceCall(chat: Chat, contextId: string) {
  const { t, i18n } = useTranslation();
  const access = useAccess();
  const capabilities = useQuery(
    ConsoleService.method.getSpeechCapabilities,
    {},
    { staleTime: 60_000 },
  );
  const report = useCallback((key: string) => void toast.error(t(key)), [t]);
  return useBrowserVoiceCall(chat, {
    contextId,
    scope: JSON.stringify([access.data?.workspace, access.data?.subject]),
    language: localStorage.getItem("speech-language") ?? i18n.resolvedLanguage?.split("-")[0] ?? "",
    capabilities: capabilities.data,
    client: consoleClient,
    report,
  });
}

export type VoiceCall = ReturnType<typeof useVoiceCall>;
