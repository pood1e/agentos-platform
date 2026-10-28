import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient, createRouterTransport } from "@connectrpc/connect";
import { createValidateInterceptor } from "@connectrpc/validate";
import { type CreateOptions, Room, TokenVerifier } from "livekit-server-sdk";
import { vi } from "vitest";
import { SpeechConfigurationSchema } from "../../gen/agentos/console/v1/speech_pb.js";
import { VoiceService } from "../../gen/agentos/voice/v1/voice_pb.js";
import { voiceConsole } from "../../server/voice/console.js";
import { voiceTickets } from "../../server/voice/tickets.js";
import { voiceService, voiceWorker } from "../../server/voice/worker.js";
import { consoleClient, environment } from "../harness.js";

export const signingKey = "api-only-voice-key-0123456789abcdef0123456789";
export const signedWorker = { headers: { authorization: "Bearer worker-token" } };
const voiceSettings = async () => ({
  resourceVersion: "1",
  configuration: create(SpeechConfigurationSchema, {
    transcription: {
      endpoint: { baseUrl: "https://asr.example/v1" },
      model: "asr",
      languageCodes: ["zh", "en"],
    },
    synthesis: {
      endpoint: { baseUrl: "https://tts.example/v1" },
      voices: [
        { languageCode: "en", model: "tts", voice: "en" },
        { languageCode: "zh", model: "tts", voice: "zh" },
      ],
    },
  }),
  transcriptionCredentialConfigured: true,
  synthesisCredentialConfigured: true,
});

export async function voiceEnvironment() {
  const env = await environment();
  const tickets = voiceTickets(signingKey, "agentos");
  const rooms = {
    url: "wss://voice.example.test",
    apiKey: "voice-key",
    apiSecret: "voice-secret-0123456789abcdef0123456789",
    agent: "agentos-voice",
    createRoom: vi.fn(async (options: CreateOptions) => new Room({ name: options.name })),
  };
  const browser = consoleClient(env, {
    voice: voiceConsole(voiceSettings, tickets, rooms, env.clients, {
      namespace: "agentos",
      name: "assistant",
    }),
  });
  const workerClient = () => {
    const service = voiceService({
      settings: voiceSettings,
      gatewayURL: "http://speech-gateway:8080",
      tickets: voiceTickets(signingKey, "agentos"),
      projection: env.projection,
      clients: env.clients,
      agent: { namespace: "agentos", name: "assistant" },
    });
    return createClient(
      VoiceService,
      createRouterTransport((router) => router.service(VoiceService, service), {
        router: {
          interceptors: [
            voiceWorker(
              async (token, audience, subjects) => {
                if (
                  token !== "worker-token" ||
                  audience !== "agentos-voice" ||
                  !subjects.includes("system:serviceaccount:agentos:agentos-voice")
                )
                  throw new ConnectError("Workload identity is invalid", Code.Unauthenticated);
              },
              "agentos-voice",
              "system:serviceaccount:agentos:agentos-voice",
            ),
            createValidateInterceptor(),
          ],
        },
      }),
    );
  };
  async function room(request: Parameters<typeof browser.startVoiceSession>[0]) {
    const { url, token } = await browser.startVoiceSession(request);
    if (url !== rooms.url) throw new Error("Wrong public LiveKit URL");
    const claims = await new TokenVerifier(rooms.apiKey, rooms.apiSecret).verify(token);
    const id = claims.video?.room ?? "";
    const tokenValue =
      rooms.createRoom.mock.calls.map((args) => args[0]).find((value) => value?.name === id)
        ?.agents?.[0]?.metadata ?? "";
    return { claims, id, sessionToken: tokenValue };
  }
  return { ...env, browser, rooms, tickets, room, worker: workerClient(), workerClient };
}
