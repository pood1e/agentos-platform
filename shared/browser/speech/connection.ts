import { DeepgramClient } from "@deepgram/sdk";

export type TranscriptionConnection = Awaited<
  ReturnType<DeepgramClient["listen"]["v1"]["connect"]>
>;

export async function openTranscription(
  signal: AbortSignal,
  language?: string,
  endpoint = "/speech",
): Promise<TranscriptionConnection> {
  const url = new URL(endpoint, location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return new DeepgramClient({ apiKey: "proxy", baseUrl: url.href }).listen.v1.connect({
    model: "configured",
    interim_results: "true",
    ...(language ? { language } : {}),
    reconnectAttempts: 0,
    connectionTimeoutInSeconds: 10,
    abortSignal: signal,
  });
}
