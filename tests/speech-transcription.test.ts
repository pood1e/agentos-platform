import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { expect, it, onTestFinished } from "vitest";
import WebSocket from "ws";
import { SpeechTranscriptionSchema } from "../gen/agentos/console/v1/speech_pb.js";
import { registerTranscription } from "../server/speech/transcription.js";

const origin = "https://agentos.example.test";
const headers = { origin, authorization: "Bearer reader-token" };

async function workbench(configured = true) {
  const directory = mkdtempSync(join(tmpdir(), "agentos-transcription-"));
  const key = join(directory, "key");
  writeFileSync(key, "private-provider-token", { mode: 0o600 });
  const provider = Fastify();
  await provider.register(websocket);
  const requests: { authorization?: string; query: unknown; frames: string[] }[] = [];
  provider.get("/v1/listen", { websocket: true }, (socket, request) => {
    const record = {
      authorization: request.headers.authorization,
      query: request.query,
      frames: [] as string[],
    };
    requests.push(record);
    socket.on("message", (data, binary) => {
      record.frames.push(binary ? "audio" : data.toString());
      socket.send(JSON.stringify({ type: "Results", is_final: !binary, text: "转写结果" }));
      if (!binary) socket.close(1000);
    });
  });
  const providerURL = await provider.listen({ host: "127.0.0.1", port: 0 });
  const app = Fastify();
  await registerTranscription(
    app,
    configured
      ? create(SpeechTranscriptionSchema, {
          endpoint: { baseUrl: `${providerURL}/v1`, apiKeyFile: key },
          model: "configured-model",
        })
      : undefined,
    async (request) => {
      if (
        request.get("origin") !== origin ||
        request.get("authorization") !== headers.authorization
      )
        throw new Error("Unauthorized");
    },
  );
  const url = await app.listen({ host: "127.0.0.1", port: 0 });
  onTestFinished(async () => {
    await app.close();
    await provider.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { app, url: `${url.replace("http:", "ws:")}/speech/v1/listen`, requests };
}

it("streams audio and interim text through the authenticated proxy before CloseStream", async () => {
  const env = await workbench();
  const socket = new WebSocket(`${env.url}?model=untrusted&language=untrusted`, { headers });
  await once(socket, "open");
  const partial = once(socket, "message");
  socket.send(Buffer.from("audio"));
  expect(JSON.parse((await partial)[0].toString())).toMatchObject({ is_final: false });
  expect(env.requests).toHaveLength(1);
  expect(env.requests[0]).toMatchObject({
    authorization: "Token private-provider-token",
    query: { model: "configured-model", interim_results: "true", endpointing: "300" },
    frames: ["audio"],
  });
  expect(env.requests[0]?.query).not.toHaveProperty("language");
  const final = once(socket, "message");
  const closed = once(socket, "close");
  socket.send(JSON.stringify({ type: "CloseStream" }));
  expect(JSON.parse((await final)[0].toString())).toMatchObject({ is_final: true });
  expect((await closed)[0]).toBe(1000);
});

it("rejects anonymous, cross-origin and disabled speech before opening a provider connection", async () => {
  const env = await workbench();
  for (const denied of [{}, { ...headers, origin: "https://other.example.test" }]) {
    const result = await env.app.inject({ url: "/speech/v1/listen", headers: denied });
    expect(result.statusCode).toBe(403);
  }
  expect(env.requests).toHaveLength(0);
  const disabled = await workbench(false);
  expect((await disabled.app.inject({ url: "/speech/v1/listen", headers })).statusCode).toBe(503);
});

it("closes unsupported controls and bounds the audio accepted per connection", async () => {
  const env = await workbench();
  const socket = new WebSocket(env.url, { headers });
  await once(socket, "open");
  const closed = once(socket, "close");
  socket.send(JSON.stringify({ type: "Configure", apiKey: "untrusted" }));
  expect((await closed)[0]).toBe(1008);
  const oversized = new WebSocket(env.url, { headers });
  await once(oversized, "open");
  const limit = once(oversized, "close");
  for (let index = 0; index < 9; index++) oversized.send(Buffer.alloc(128 * 1024));
  expect((await limit)[0]).toBe(1009);
});
