import { randomUUID } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient, createRouterTransport } from "@connectrpc/connect";
import { createValidateInterceptor } from "@connectrpc/validate";
import { TokenVerifier } from "livekit-server-sdk";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SpeechConfigurationSchema, VoiceMode } from "../gen/agentos/console/v1/speech_pb.js";
import { ExecutionIdentitySchema } from "../gen/agentos/execution/v1/identity_pb.js";
import { VoiceService } from "../gen/agentos/voice/v1/voice_pb.js";
import { voiceConsole } from "../server/voice/console.js";
import { type VoiceSessions, voiceSessions } from "../server/voice/sessions.js";
import { voiceService, voiceWorker } from "../server/voice/worker.js";
import { allCapabilities } from "../shared/permissions.js";
import { consoleClient, type Environment, environment } from "./harness.js";

const uri = process.env.CHANGE_TEST_DATABASE_URL ?? "";
const rooms = {
  url: "wss://voice.example.test",
  apiKey: "voice-key",
  apiSecret: "voice-secret-0123456789abcdef0123456789",
  agent: "agentos-voice",
};
const subject = "system:serviceaccount:agentos:agentos-voice";
const settings = async () => ({
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
  transcriptionCredential: "asr-key",
  synthesisCredential: "tts-key",
});
const agent = { namespace: "agentos", name: "assistant" };
const signed = { headers: { authorization: "Bearer worker-token" } };

let env: Environment;
let sessions: VoiceSessions;
let browser: ReturnType<typeof consoleClient>;
let worker: ReturnType<typeof createClient<typeof VoiceService>>;

beforeAll(async () => {
  env = await environment();
  await env.reconcile.refresh();
  sessions = await voiceSessions(uri, `voice-${randomUUID()}`);
  const voice = voiceConsole(settings, sessions, rooms, env.clients, env.executions);
  browser = consoleClient(env, { voice });
  const review = async (token: string, audience: string, subjects: string[]) => {
    if (token !== "worker-token" || audience !== "agentos-voice" || !subjects.includes(subject))
      throw new ConnectError("Workload identity is invalid", Code.Unauthenticated);
  };
  const service = voiceService({
    settings,
    sessions,
    projection: env.projection,
    clients: env.clients,
    executions: env.executions,
    initiator: async (id) => (await env.store.identity(id))?.value,
    agent,
  });
  worker = createClient(
    VoiceService,
    createRouterTransport((router) => router.service(VoiceService, service), {
      router: {
        interceptors: [voiceWorker(review, "agentos-voice", subject), createValidateInterceptor()],
      },
    }),
  );
});
afterAll(async () => {
  await sessions.close();
  await env.close();
});

async function room(request: Parameters<typeof browser.startVoiceSession>[0], client = browser) {
  const { url, token } = await client.startVoiceSession(request);
  expect(url).toBe(rooms.url);
  const claims = await new TokenVerifier(rooms.apiKey, rooms.apiSecret).verify(token);
  return { claims, id: claims.video?.room ?? "" };
}

async function answer(sessionId: string, taskId: string) {
  for (;;) {
    const result = await worker.getVoiceAnswer({ sessionId, taskId }, signed);
    if (result.done) return result.answer;
  }
}

describe("voice sessions", () => {
  it("issues single-room tokens that dispatch the voice agent", async () => {
    const reading = await room({ mode: VoiceMode.READ_ALOUD, text: "**系统健康。** All good." });
    expect(reading.claims.video).toMatchObject({ roomJoin: true, canPublish: false });
    expect(reading.claims.roomConfig).toMatchObject({
      maxParticipants: 2,
      agents: [{ agentName: "agentos-voice" }],
    });
    expect(await worker.getVoiceSession({ sessionId: reading.id }, signed)).toMatchObject({
      mode: VoiceMode.READ_ALOUD,
      speech: { text: "系统健康。 All good.", languageCode: "zh" },
      transcriptionCredential: "asr-key",
      synthesisCredential: "tts-key",
    });
    const dictation = await room({ mode: VoiceMode.DICTATION, languageCode: "en" });
    expect(dictation.claims.video).toMatchObject({
      canPublish: true,
      canPublishSources: ["microphone"],
    });
    expect(await worker.getVoiceSession({ sessionId: dictation.id }, signed)).toMatchObject({
      mode: VoiceMode.DICTATION,
      languageCode: "en",
    });
    await expect(
      browser.startVoiceSession({ mode: VoiceMode.DICTATION, languageCode: "ar" }),
    ).rejects.toMatchObject({ code: Code.InvalidArgument, rawMessage: "speech.requestRejected" });
  });

  it("reports voice as unavailable when the deployment has none", async () => {
    const client = consoleClient(env);
    expect(await client.getSpeechCapabilities({})).toMatchObject({ enabled: false });
    await expect(client.startVoiceSession({ mode: VoiceMode.DICTATION })).rejects.toMatchObject({
      code: Code.FailedPrecondition,
      rawMessage: "speech.unavailable",
    });
    expect(await browser.getSpeechCapabilities({})).toMatchObject({
      enabled: true,
      transcription: true,
      synthesis: true,
      transcriptionLanguages: ["zh", "en"],
    });
  });

  it("sends call turns as the initiator and binds the conversation they start", async () => {
    const call = await room({ mode: VoiceMode.CALL });
    const turn = { sessionId: call.id, messageId: randomUUID(), text: "巡检 agentos-lab" };
    const sent = await worker.sendVoiceTurn(turn, signed);
    expect(await worker.sendVoiceTurn(turn, signed)).toEqual(sent);
    expect(await answer(call.id, sent.taskId)).toMatchObject({
      text: "已处理：巡检 agentos-lab",
      languageCode: "zh",
    });
    const next = await worker.sendVoiceTurn(
      { sessionId: call.id, messageId: randomUUID(), text: "继续" },
      signed,
    );
    expect(next.contextId).toBe(sent.contextId);
    const { conversations } = await browser.listConversations({ agent, pageSize: 12 });
    expect(conversations.map((item) => item.contextId)).toContain(sent.contextId);
  });

  it("rejects worker requests outside the session's conversation, mode, lifetime or initiator", async () => {
    const denied = { code: Code.PermissionDenied };
    const first = await room({ mode: VoiceMode.CALL });
    const sent = await worker.sendVoiceTurn(
      { sessionId: first.id, messageId: randomUUID(), text: "巡检" },
      signed,
    );
    const other = await room({ mode: VoiceMode.CALL });
    await expect(
      worker.getVoiceAnswer({ sessionId: other.id, taskId: sent.taskId }, signed),
    ).rejects.toMatchObject(denied);
    await expect(
      worker.cancelVoiceTurn({ sessionId: other.id, taskId: sent.taskId }, signed),
    ).rejects.toMatchObject(denied);

    const dictation = await room({ mode: VoiceMode.DICTATION });
    await expect(
      worker.sendVoiceTurn({ sessionId: dictation.id, messageId: randomUUID(), text: "x" }, signed),
    ).rejects.toMatchObject(denied);

    const sql = postgres(uri, { max: 1, onnotice: () => {} });
    await sql`update agentos_voice.sessions set expires_at = now() where id = ${first.id}::uuid`;
    await sql.end();
    await expect(worker.getVoiceSession({ sessionId: first.id }, signed)).rejects.toMatchObject(
      denied,
    );

    await expect(worker.getVoiceSession({ sessionId: other.id })).rejects.toMatchObject({
      code: Code.Unauthenticated,
    });

    const guest = create(ExecutionIdentitySchema, {
      subject: "user:guest",
      write: true,
      capabilities: allCapabilities,
      credential: { case: "accessToken", value: "guest-token" },
    });
    const visitor = consoleClient(
      env,
      { voice: voiceConsole(settings, sessions, rooms, env.clients, env.executions) },
      () => guest,
    );
    await expect(visitor.startVoiceSession({ mode: VoiceMode.CALL })).rejects.toMatchObject({
      code: Code.FailedPrecondition,
      rawMessage: "delegation.required",
    });
    await env.store.saveIdentity({ ...guest, credential: { case: "service", value: true } });
    await expect(
      visitor.startVoiceSession({ mode: VoiceMode.CALL, contextId: sent.contextId }),
    ).rejects.toMatchObject(denied);
  });
});
