import { randomUUID } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { Code } from "@connectrpc/connect";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { VoiceMode } from "../gen/agentos/console/v1/speech_pb.js";
import { ExecutionIdentitySchema } from "../gen/agentos/execution/v1/identity_pb.js";
import { voiceConsole } from "../server/voice/console.js";
import { allCapabilities } from "../shared/permissions.js";
import { signedWorker, voiceEnvironment, voiceSettings } from "./fixtures/voice.js";
import { consoleClient } from "./harness.js";

let env: Awaited<ReturnType<typeof voiceEnvironment>>;
beforeAll(async () => {
  env = await voiceEnvironment();
});
afterAll(async () => {
  await env.close();
});

const agent = { namespace: "agentos", name: "assistant" };
async function answer(sessionId: string, sessionToken: string, taskId: string) {
  for (;;) {
    const result = await env.worker.getVoiceAnswer(
      { sessionId, sessionToken, taskId },
      signedWorker,
    );
    if (result.done) return result.answer;
  }
}

it("dispatches API-signed tickets through the LiveKit server without exposing them to browsers", async () => {
  const reading = await env.room({ mode: VoiceMode.READ_ALOUD, text: "**系统健康。** All good." });
  expect(reading.claims.video).toMatchObject({ roomJoin: true, canPublish: false });
  expect(reading.claims.roomConfig).toBeUndefined();
  expect(JSON.stringify(reading.claims)).not.toContain(reading.sessionToken);
  expect(env.rooms.createRoom).toHaveBeenCalledWith({
    name: reading.id,
    maxParticipants: 2,
    emptyTimeout: 60,
    agents: [
      expect.objectContaining({ agentName: "agentos-voice", metadata: reading.sessionToken }),
    ],
  });
  const value = await env.worker.getVoiceSession(
    { sessionId: reading.id, sessionToken: reading.sessionToken },
    signedWorker,
  );
  expect(value).toMatchObject({
    mode: VoiceMode.READ_ALOUD,
    speech: { text: "系统健康。 All good.", languageCode: "zh" },
    configuration: {
      transcription: {
        endpoint: { baseUrl: "http://speech-gateway:8080/speech/transcription/v1" },
      },
      synthesis: { endpoint: { baseUrl: "http://speech-gateway:8080/speech/synthesis" } },
    },
  });
  expect(JSON.stringify(value)).not.toMatch(
    /credential|asr-key|tts-key|asr\.example|tts\.example/i,
  );
  const dictation = await env.room({ mode: VoiceMode.DICTATION, languageCode: "en" });
  expect(dictation.claims.video).toMatchObject({
    canPublish: true,
    canPublishSources: ["microphone"],
  });
  expect(
    await env.worker.getVoiceSession(
      { sessionId: dictation.id, sessionToken: dictation.sessionToken },
      signedWorker,
    ),
  ).toMatchObject({ mode: VoiceMode.DICTATION, languageCode: "en" });
  await expect(
    env.browser.startVoiceSession({ mode: VoiceMode.DICTATION, languageCode: "ar" }),
  ).rejects.toMatchObject({ code: Code.InvalidArgument, rawMessage: "speech.requestRejected" });
});

it("reports voice as unavailable when the deployment has none or the media server fails", async () => {
  const client = consoleClient(env);
  expect(await client.getSpeechCapabilities({})).toMatchObject({ enabled: false });
  await expect(client.startVoiceSession({ mode: VoiceMode.DICTATION })).rejects.toMatchObject({
    code: Code.FailedPrecondition,
    rawMessage: "speech.unavailable",
  });
  expect(await env.browser.getSpeechCapabilities({})).toMatchObject({
    enabled: true,
    transcription: true,
    synthesis: true,
    transcriptionLanguages: ["zh", "en"],
  });
  env.rooms.createRoom.mockRejectedValueOnce(new Error("LiveKit unavailable"));
  await expect(env.browser.startVoiceSession({ mode: VoiceMode.DICTATION })).rejects.toMatchObject({
    code: Code.Unavailable,
  });
});

it("reuses the native request_id across initial ticket replay and API restart", async () => {
  const call = await env.room({ mode: VoiceMode.CALL });
  const previousSessions = env.fake.sessions.size;
  const createSession = vi.spyOn(env.clients.sessions, "createSession");
  const turn = {
    sessionId: call.id,
    sessionToken: call.sessionToken,
    messageId: call.id,
    text: "巡检 agentos-lab",
  };
  const [sent, concurrent] = await Promise.all([
    env.worker.sendVoiceTurn(turn, signedWorker),
    env.workerClient().sendVoiceTurn(turn, signedWorker),
  ]);
  expect(concurrent).toEqual(sent);
  const replay = await env.workerClient().sendVoiceTurn(turn, signedWorker);
  expect(replay).toEqual(sent);
  expect(createSession).toHaveBeenCalledWith(
    { agent, requestId: call.id, name: "巡检 agentos-lab" },
    { timeoutMs: 30_000 },
  );
  expect(await answer(call.id, sent.sessionToken, sent.taskId)).toMatchObject({
    text: "已处理：巡检 agentos-lab",
    languageCode: "zh",
  });
  const next = await env.worker.sendVoiceTurn(
    { ...turn, sessionToken: sent.sessionToken, messageId: randomUUID(), text: "继续" },
    signedWorker,
  );
  expect(next.contextId).toBe(sent.contextId);
  await answer(call.id, next.sessionToken, next.taskId);
  await expect(
    env.worker.sendVoiceTurn(
      { ...turn, messageId: randomUUID(), text: "重放首轮令牌" },
      signedWorker,
    ),
  ).rejects.toMatchObject({ code: Code.PermissionDenied });
  expect(env.fake.sessions.size).toBe(previousSessions + 1);
  const { conversations } = await env.browser.listConversations({ agent, pageSize: 12 });
  expect(conversations.map((item) => item.contextId)).toContain(sent.contextId);
  createSession.mockRestore();
});

it("rejects requests outside the ticket's conversation, room, mode or lifetime", async () => {
  const denied = { code: Code.PermissionDenied };
  const first = await env.room({ mode: VoiceMode.CALL });
  const sent = await env.worker.sendVoiceTurn(
    {
      sessionId: first.id,
      sessionToken: first.sessionToken,
      messageId: first.id,
      text: "巡检",
    },
    signedWorker,
  );
  const other = await env.room({ mode: VoiceMode.CALL });
  for (const method of ["getVoiceAnswer", "cancelVoiceTurn"] as const) {
    await expect(
      env.worker[method](
        { sessionId: other.id, sessionToken: other.sessionToken, taskId: sent.taskId },
        signedWorker,
      ),
    ).rejects.toMatchObject(denied);
  }
  await expect(
    env.worker.getVoiceSession(
      { sessionId: other.id, sessionToken: sent.sessionToken },
      signedWorker,
    ),
  ).rejects.toMatchObject(denied);
  const dictation = await env.room({ mode: VoiceMode.DICTATION });
  await expect(
    env.worker.sendVoiceTurn(
      {
        sessionId: dictation.id,
        sessionToken: dictation.sessionToken,
        messageId: randomUUID(),
        text: "x",
      },
      signedWorker,
    ),
  ).rejects.toMatchObject(denied);
  await expect(
    env.worker.getVoiceSession({ sessionId: other.id, sessionToken: other.sessionToken }),
  ).rejects.toMatchObject({ code: Code.Unauthenticated });
  vi.useFakeTimers();
  try {
    vi.setSystemTime(Date.now() + 31 * 60_000);
    await expect(
      env.worker.getVoiceSession(
        { sessionId: first.id, sessionToken: sent.sessionToken },
        signedWorker,
      ),
    ).rejects.toMatchObject(denied);
  } finally {
    vi.useRealTimers();
  }
});

it("requires delegation and rejects continuing a call after its execution is revoked", async () => {
  const call = await env.room({ mode: VoiceMode.CALL });
  const sent = await env.worker.sendVoiceTurn(
    { sessionId: call.id, sessionToken: call.sessionToken, messageId: call.id, text: "巡检" },
    signedWorker,
  );
  const guest = create(ExecutionIdentitySchema, {
    subject: "user:guest",
    write: true,
    capabilities: allCapabilities,
    credential: { case: "accessToken", value: "guest-token" },
  });
  const visitor = consoleClient(
    env,
    { voice: voiceConsole(voiceSettings, env.tickets, env.rooms, env.clients, env.executions) },
    () => guest,
  );
  await expect(visitor.startVoiceSession({ mode: VoiceMode.CALL })).rejects.toMatchObject({
    code: Code.FailedPrecondition,
    rawMessage: "delegation.required",
  });
  await env.store.saveIdentity({ ...guest, credential: { case: "service", value: true } });
  await expect(
    visitor.startVoiceSession({ mode: VoiceMode.CALL, contextId: sent.contextId }),
  ).rejects.toMatchObject({ code: Code.PermissionDenied });
  const { session } = await env.clients.sessions.getSession({ sessionId: sent.contextId });
  const owner = (await env.store.identity("user:operator"))?.value;
  if (!session || !owner) throw new Error("Fixture identity missing");
  await env.executions.revoke(session, owner);
  await expect(
    env.workerClient().sendVoiceTurn(
      {
        sessionId: call.id,
        sessionToken: call.sessionToken,
        messageId: call.id,
        text: "重试首轮",
      },
      signedWorker,
    ),
  ).rejects.toMatchObject({ code: Code.PermissionDenied });
  await expect(
    env.worker.sendVoiceTurn(
      {
        sessionId: call.id,
        sessionToken: sent.sessionToken,
        messageId: randomUUID(),
        text: "重试",
      },
      signedWorker,
    ),
  ).rejects.toMatchObject({ code: Code.PermissionDenied });
  for (const method of ["getVoiceAnswer", "cancelVoiceTurn"] as const)
    await expect(
      env.worker[method](
        { sessionId: call.id, sessionToken: sent.sessionToken, taskId: sent.taskId },
        signedWorker,
      ),
    ).rejects.toMatchObject({ code: Code.PermissionDenied });
});
