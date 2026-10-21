import { DeepgramClient } from "@deepgram/sdk";

export type TranscriptionConnection = Awaited<
  ReturnType<DeepgramClient["listen"]["v1"]["connect"]>
>;

export async function openTranscription(signal: AbortSignal) {
  const url = new URL("/speech", location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return new DeepgramClient({ apiKey: "proxy", baseUrl: url.href }).listen.v1.connect({
    model: "configured",
    interim_results: "true",
    reconnectAttempts: 0,
    connectionTimeoutInSeconds: 10,
    abortSignal: signal,
  });
}
