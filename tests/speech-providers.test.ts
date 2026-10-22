import { once } from "node:events";
import { create } from "@bufbuild/protobuf";
import { createHandlerContext } from "@connectrpc/connect";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { expect, it, onTestFinished } from "vitest";
import WebSocket from "ws";
import { ConsoleService } from "../gen/agentos/console/v1/console_service_pb.js";
import {
  SpeechConfigurationSchema,
  SpeechSynthesis_Protocol,
  SpeechTranscription_Protocol,
  SynthesizeSpeechRequestSchema,
} from "../gen/agentos/console/v1/speech_pb.js";
import { speechService } from "../server/speech/service.js";
import { registerTranscription } from "../server/speech/transcription.js";

it("preserves native cumulative drafts and drains WhisperLiveKit through empty binary input", async () => {
  const provider = Fastify();
  await provider.register(websocket);
  let ended = false;
  provider.get("/asr", { websocket: true }, (socket, request) => {
    expect(request.query).toEqual({ language: "ar" });
    socket.send(JSON.stringify({ type: "config" }));
    socket.on("message", (data, binary) => {
      expect(binary).toBe(true);
      if (Buffer.isBuffer(data) && data.length === 0) {
        ended = true;
        socket.send(JSON.stringify({ type: "ready_to_stop" }));
      } else {
        for (const buffer of ["تشكلت", "تشكلت في المحيط الأطلسي / styles"])
          socket.send(
            JSON.stringify({
              lines: [{ text: buffer, speaker: 1 }],
              buffer_transcription: "",
              buffer_diarization: "",
            }),
          );
      }
    });
  });
  const providerUrl = await provider.listen({ host: "127.0.0.1", port: 0 });
  const app = Fastify();
  await registerTranscription(
    app,
    async () => ({
      resourceVersion: "1",
      configuration: create(SpeechConfigurationSchema, {
        transcription: {
          endpoint: { baseUrl: `${providerUrl}/v1` },
          model: "large-v3",
          languageCodes: ["ar"],
          protocol: SpeechTranscription_Protocol.WHISPERLIVEKIT,
        },
      }),
    }),
    async () => {},
  );
  const url = await app.listen({ host: "127.0.0.1", port: 0 });
  const socket = new WebSocket(`${url.replace("http:", "ws:")}/speech/v1/listen?language=ar`);
  onTestFinished(async () => {
    socket.terminate();
    await app.close();
    await provider.close();
  });
  const drafts: string[] = [];
  socket.on("message", (data) => {
    const result = JSON.parse(data.toString());
    expect(result.is_final).toBe(false);
    drafts.push(result.channel.alternatives[0].transcript);
    if (drafts.length === 2) socket.send(JSON.stringify({ type: "CloseStream" }));
  });
  await once(socket, "open");
  const closed = once(socket, "close");
  socket.send(Buffer.from("webm"));
  expect((await closed)[0]).toBe(1000);
  expect(ended).toBe(true);
  expect(drafts).toEqual(["تشكلت", "تشكلت في المحيط الأطلسي / styles"]);
});

it.each([
  ["zh", "你好", "zh"],
  ["en", "Hello", "en"],
  ["ar", "مرحبا", "ar-MSA"],
  ["zh", "请检查 nginx Pod 的 CPU 和 memory。", "zh"],
  ["zh", "Nginx Pod Running，CPU 80%，Memory 75%，建议检查。", "zh"],
  ["zh", "RCA 完成：nginx deployment CrashLoopBackOff，建议检查 memory limit。", "zh"],
  ["ar", "نعم، Kubernetes Deployment nginx و Prometheus يعملان بشكل طبيعي.", "ar-MSA"],
  ["en", "Please inspect Kubernetes Deployment nginx and Prometheus metrics.", "en"],
])("uses NeMo's %s language and streamed PCM format", async (_language, text, expected) => {
  const provider = Fastify();
  provider.post("/v1/audio/speech", (request, reply) => {
    expect(request.body).toEqual({
      model: "magpie",
      voice: "Aria",
      input: text,
      response_format: "pcm",
      language: expected,
      sample_rate: 22050,
    });
    return reply.type("audio/pcm;rate=22050;channels=1").send(Buffer.from("PCM-audio"));
  });
  const url = await provider.listen({ host: "127.0.0.1", port: 0 });
  onTestFinished(() => provider.close());
  const service = speechService(async () => ({
    resourceVersion: "1",
    configuration: create(SpeechConfigurationSchema, {
      synthesis: {
        endpoint: { baseUrl: `${url}/v1` },
        protocol: SpeechSynthesis_Protocol.NEMO,
        voices: ["zh", "en", "ar"].map((languageCode) => ({
          languageCode,
          model: "magpie",
          voice: "Aria",
        })),
      },
    }),
  }));
  const context = createHandlerContext({
    service: ConsoleService,
    method: ConsoleService.method.synthesizeSpeech,
    protocolName: "connect",
    requestMethod: "POST",
    url: url,
  });
  const chunks = [];
  for await (const chunk of service.synthesizeSpeech(
    create(SynthesizeSpeechRequestSchema, { text }),
    context,
  ))
    chunks.push(chunk.audio?.data ?? new Uint8Array());
  expect(Buffer.concat(chunks).toString()).toBe("PCM-audio");
});
