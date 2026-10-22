import { createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import Fastify from "fastify";
import { createLocalJWKSet } from "jose";
import type OpenAI from "openai";
import { afterAll, beforeAll, expect, it, onTestFinished } from "vitest";
import { ConsoleService } from "../gen/agentos/console/v1/console_service_pb.js";
import { SpeechConfigurationSchema } from "../gen/agentos/console/v1/speech_pb.js";
import { ErrorInfoSchema } from "../gen/google/rpc/error_details_pb.js";
import { jwtIdentity } from "../server/authorization/oidc.js";
import { registerConsole } from "../server/console/app.js";
import { loadPack } from "../server/console/pack.js";
import { consoleService } from "../server/console/service.js";
import { workspaceContext } from "../server/platform/access.js";
import { speechService } from "../server/speech/service.js";
import { identityIssuer, identityToken } from "./fixtures/identity.js";
import { environment, testBindings, until } from "./harness.js";

const provider = Fastify({ forceCloseConnections: true });
const origin = "https://agentos.example.test";
const token = await identityToken([], "speech-reader");
const publicKey = createPublicKey(readFileSync("tests/fixtures/identity/tls.key")).export({
  format: "jwk",
});
const identity = jwtIdentity(
  { issuer: identityIssuer, audience: "console", writerRole: "writer", origin },
  createLocalJWKSet({ keys: [publicKey] }),
);
const calls: { transcription?: FormData; synthesis?: OpenAI.Audio.SpeechCreateParams } = {};
let providerURL = "";
let canceled = false;
let waiting = false;
let synthesisCanceled = false;

beforeAll(async () => {
  provider.addContentTypeParser(
    "multipart/form-data",
    { parseAs: "buffer" },
    (_request, body, done) => done(null, body),
  );
  provider.post<{ Body: Buffer }>("/v1/audio/transcriptions", async (request, reply) => {
    calls.transcription = await new Response(new Uint8Array(request.body).buffer, {
      headers: { "content-type": request.headers["content-type"] ?? "" },
    }).formData();
    if (calls.transcription.get("model") === "unavailable")
      return reply.code(503).send({ error: { message: "private upstream credential" } });
    if (calls.transcription.get("model") === "cancel") {
      reply.hijack();
      waiting = true;
      await new Promise<void>((resolve) =>
        reply.raw.on("close", () => {
          canceled = true;
          resolve();
        }),
      );
      return;
    }
    return { text: "检查交换机 / Check the switch / افحص المحول" };
  });
  provider.post<{ Body: OpenAI.Audio.SpeechCreateParams }>("/v1/audio/speech", (request, reply) => {
    calls.synthesis = request.body;
    if (request.body.model === "streaming") {
      reply.hijack();
      reply.raw.writeHead(200, { "content-type": "audio/mpeg" });
      reply.raw.write(Buffer.from("ID3-first-audio"));
      reply.raw.on("close", () => {
        synthesisCanceled = true;
      });
      return;
    }
    if (request.body.model === "unavailable")
      return reply.code(503).send({ error: { message: "private upstream credential" } });
    if (request.body.model === "oversized")
      return reply.type("audio/wav").send(Buffer.alloc(16 * 1024 * 1024 + 1));
    if (request.body.model === "empty") return reply.type("audio/wav").send(Buffer.alloc(0));
    if (request.body.model === "wrong-format") return { unexpected: "not audio" };
    if (request.body.model === "mp3") return reply.type("audio/mp3").send(Buffer.from("ID3-audio"));
    return reply.type("audio/wav").send(Buffer.from("RIFF-test-audio"));
  });
  providerURL = `${await provider.listen({ host: "127.0.0.1", port: 0 })}/v1`;
});

afterAll(() => provider.close());

async function workbench(
  input = "",
  output = "",
  authenticated = true,
  voices = [{ languageCode: "en", model: output, voice: "multilingual" }],
) {
  const env = environment();
  const app = Fastify();
  await registerConsole(app, {
    context: workspaceContext("agentos", "assistant", authenticated ? identity : undefined, origin),
    service: consoleService({
      ...env,
      namespace: "agentos",
      access: testBindings(env.fake),
      operations: { $typeName: "agentos.governance.v1.GovernanceConfig", environments: [] },
      roleDefaults: { modelConfig: "default-model-config", harness: "standard" },
      replaceTemplate: async (value) => env.fake.replaceTemplate(value),
      pack: loadPack(),
      speech: speechService(async () => ({
        resourceVersion: "1",
        configuration: create(SpeechConfigurationSchema, {
          transcription: input ? { endpoint: { baseUrl: providerURL }, model: input } : undefined,
          synthesis: output ? { endpoint: { baseUrl: providerURL }, voices } : undefined,
        }),
      })),
    }),
    ready: () => true,
  });
  const url = await app.listen({ host: "127.0.0.1", port: 0 });
  onTestFinished(async () => {
    env.sync.close();
    await app.close();
  });
  return createClient(
    ConsoleService,
    createConnectTransport({ baseUrl: url, httpVersion: "1.1", useBinaryFormat: true }),
  );
}

const headers = { authorization: `Bearer ${token}`, origin };
const audio = { contentType: "audio/webm;codecs=opus", data: new Uint8Array([1, 2, 3]) };

it.each([
  [false, false],
  [true, false],
  [false, true],
  [true, true],
])(
  "advertises input=%s and output=%s independently without exposing provider configuration",
  async (input, output) => {
    const client = await workbench(input ? "asr" : "", output ? "tts" : "");
    const result = await client.getSpeechCapabilities({}, { headers });
    expect(result).toEqual({
      $typeName: "agentos.console.v1.GetSpeechCapabilitiesResponse",
      transcription: input,
      synthesis: output,
      transcriptionLanguages: [],
    });
  },
);

async function synthesize(
  client: Awaited<ReturnType<typeof workbench>>,
  request: { text: string },
  options?: Parameters<typeof client.synthesizeSpeech>[1],
) {
  const data: Uint8Array[] = [];
  let contentType: string | undefined;
  for await (const chunk of client.synthesizeSpeech(request, options)) {
    contentType = chunk.audio?.contentType;
    if (chunk.audio) data.push(chunk.audio.data);
  }
  return { audio: { contentType, data: Buffer.concat(data) } };
}

it("keeps unconfigured speech unavailable while open access remains supported", async () => {
  const client = await workbench("", "", false);
  expect(await client.getSpeechCapabilities({})).toMatchObject({
    transcription: false,
    synthesis: false,
  });
  await expect(client.transcribeAudio({ audio })).rejects.toMatchObject({
    code: Code.FailedPrecondition,
  });
  await expect(synthesize(client, { text: "你好" })).rejects.toMatchObject({
    code: Code.FailedPrecondition,
  });
});

it("allows a reader to transcribe and synthesize multilingual text without gaining write permissions", async () => {
  const client = await workbench("asr", "tts");
  expect((await client.getAccessProfile({}, { headers })).profile).toMatchObject({
    write: false,
    capabilities: [],
  });
  const result = await client.transcribeAudio({ audio }, { headers });
  expect(result.text).toContain("افحص المحول");
  expect(calls.transcription?.get("model")).toBe("asr");
  const file = calls.transcription?.get("file");
  expect(file).toBeInstanceOf(File);
  if (!(file instanceof File)) throw new Error("Expected an uploaded audio file");
  expect(file.name).toBe("recording.webm");
  expect(new Uint8Array(await file.arrayBuffer())).toEqual(audio.data);
  const response = await synthesize(client, { text: result.text }, { headers });
  expect(response.audio?.contentType).toBe("audio/wav");
  expect(new TextDecoder().decode(response.audio?.data)).toBe("RIFF-test-audio");
  expect(calls.synthesis).toEqual({
    model: "tts",
    input: result.text,
    voice: "multilingual",
    response_format: "mp3",
  });
  expect((await client.getAccessProfile({}, { headers })).profile?.write).toBe(false);
});

it("requires authentication and same-origin access for speech requests", async () => {
  const client = await workbench("asr", "tts");
  await expect(client.getSpeechCapabilities({})).rejects.toMatchObject({
    code: Code.Unauthenticated,
  });
  const foreign = { ...headers, origin: "https://other.example.test" };
  await expect(client.transcribeAudio({ audio }, { headers: foreign })).rejects.toMatchObject({
    code: Code.PermissionDenied,
  });
  await expect(synthesize(client, { text: "test" }, { headers: foreign })).rejects.toMatchObject({
    code: Code.PermissionDenied,
  });
  await expect(
    synthesize(client, { text: "test" }, { headers: { "x-forwarded-access-token": token } }),
  ).rejects.toMatchObject({ code: Code.PermissionDenied });
});

it.each([
  ["zh", "请检查交换机的状态。"],
  ["en", "Please check the status of the network switch."],
  ["ar", "يرجى التحقق من حالة محول الشبكة."],
  ["zh", "你好"],
  ["en", "Hello"],
  ["ar", "مرحبا"],
  ["zh", "请检查 nginx Pod 的 CPU 和 memory。"],
  ["ar", "نعم، Kubernetes Deployment nginx و Prometheus يعملان بشكل طبيعي."],
])(
  "selects the configured %s voice from the text independently of the UI language",
  async (language, text) => {
    const voices = ["zh", "en", "ar"].map((code) => ({
      languageCode: code,
      model: `tts-${code}`,
      voice: `voice-${code}`,
    }));
    const client = await workbench("", "tts", true, voices);
    await synthesize(client, { text }, { headers });
    expect(calls.synthesis).toMatchObject({ model: `tts-${language}`, voice: `voice-${language}` });
  },
);

it("supports configured speech without an OIDC provider", async () => {
  const client = await workbench("asr", "tts", false);
  const result = await client.transcribeAudio({ audio });
  expect(result.text).toContain("افحص المحول");
  expect((await synthesize(client, { text: result.text })).audio?.data.length).toBeGreaterThan(0);
});

it("normalizes an upstream MP3 MIME alias for browser playback and audio uploads", async () => {
  const client = await workbench("", "mp3");
  expect((await synthesize(client, { text: "Hello" }, { headers })).audio?.contentType).toBe(
    "audio/mpeg",
  );
});

it("rejects empty, oversized and unsupported input before calling the provider", async () => {
  const client = await workbench("asr", "tts");
  for (const invalid of [
    { ...audio, data: new Uint8Array() },
    { ...audio, data: new Uint8Array(1024 * 1024 + 1) },
    { ...audio, contentType: "text/plain" },
  ])
    await expect(client.transcribeAudio({ audio: invalid }, { headers })).rejects.toMatchObject({
      code: Code.InvalidArgument,
    });
  for (const text of ["", "x".repeat(8001)])
    await expect(synthesize(client, { text }, { headers })).rejects.toMatchObject({
      code: Code.InvalidArgument,
    });
});

it("redacts upstream failures and returns a localized error", async () => {
  const client = await workbench("unavailable", "unavailable");
  for (const request of [
    client.transcribeAudio({ audio }, { headers }),
    synthesize(client, { text: "test" }, { headers }),
  ]) {
    const error = await request.catch((reason: unknown) => reason);
    expect(error).toMatchObject({ code: Code.Unavailable });
    expect(String(error)).not.toContain("credential");
    if (!(error instanceof ConnectError)) throw new Error("Expected a ConnectError");
    expect(error.findDetails(ErrorInfoSchema)[0]?.reason).toBe("speech.unavailable");
  }
});

it.each([
  ["oversized", Code.ResourceExhausted],
  ["empty", Code.Unavailable],
  ["wrong-format", Code.Unavailable],
])("rejects %s synthesis responses", async (model, code) => {
  const client = await workbench("", String(model));
  await expect(synthesize(client, { text: "test" }, { headers })).rejects.toMatchObject({
    code,
  });
});

it("cancels the upstream transcription when the browser cancels its request", async () => {
  const client = await workbench("cancel");
  const controller = new AbortController();
  const result = client
    .transcribeAudio({ audio }, { headers, signal: controller.signal })
    .catch((error: unknown) => error);
  await until(() => waiting);
  controller.abort();
  expect(await result).toMatchObject({ code: Code.Canceled });
  await until(() => canceled);
});

it("returns synthesized audio before the provider finishes and propagates playback cancellation", async () => {
  const client = await workbench("", "streaming");
  const controller = new AbortController();
  const responses = client
    .synthesizeSpeech({ text: "Hello" }, { headers, signal: controller.signal })
    [Symbol.asyncIterator]();
  const first = await responses.next();
  expect(new TextDecoder().decode(first.value?.audio?.data)).toBe("ID3-first-audio");
  expect(synthesisCanceled).toBe(false);
  controller.abort();
  await until(() => synthesisCanceled);
});
