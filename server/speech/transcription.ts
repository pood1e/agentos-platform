import { readFileSync } from "node:fs";
import websocket from "@fastify/websocket";
import type { FastifyInstance } from "fastify";
import WebSocket from "ws";
import {
  type SpeechTranscription,
  SpeechTranscription_Protocol,
} from "../../gen/agentos/console/v1/speech_pb.js";
import { whisperLiveKitResult } from "./whisperlivekit.js";

export async function registerTranscription(
  app: FastifyInstance,
  configuration: SpeechTranscription | undefined,
  authorize: (headers: Headers) => Promise<void>,
) {
  const clients = new Set<WebSocket>();
  await app.register(websocket, { options: { maxPayload: 256 * 1024 } });
  app.addHook("onClose", async () => {
    for (const client of clients) client.close(1001);
  });
  app.get(
    "/speech/v1/listen",
    {
      websocket: true,
      preValidation: async (request, reply) => {
        if (!configuration?.endpoint) return reply.code(503).send();
        const headers = new Headers();
        for (const [key, value] of Object.entries(request.headers))
          if (typeof value === "string") headers.set(key, value);
        try {
          await authorize(headers);
        } catch {
          return reply.code(403).send();
        }
        if (clients.size >= 4) return reply.code(429).send();
      },
    },
    (socket, request) => {
      if (!configuration?.endpoint) return socket.close(1011);
      if (clients.size >= 4) return socket.close(1008, "Transcription capacity reached");
      clients.add(socket);
      const endpoint = configuration.endpoint;
      const native = configuration.protocol === SpeechTranscription_Protocol.WHISPERLIVEKIT;
      const url = new URL(native ? "../asr" : "listen", `${endpoint.baseUrl.replace(/\/$/, "")}/`);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      if (!native) {
        url.searchParams.set("model", configuration.model);
        url.searchParams.set("interim_results", "true");
        url.searchParams.set("endpointing", "300");
      }
      const language = new URL(request.url, "http://localhost").searchParams.get("language");
      if (language && configuration.languageCodes.includes(language))
        url.searchParams.set("language", language);
      const token = endpoint.apiKeyFile ? readFileSync(endpoint.apiKeyFile, "utf8").trim() : "";
      const upstream = new WebSocket(url, {
        headers: token ? { Authorization: `${native ? "Bearer" : "Token"} ${token}` } : {},
        handshakeTimeout: 10_000,
        maxPayload: 1024 * 1024,
      });
      let size = 0;
      const pending: { data: WebSocket.RawData; binary: boolean }[] = [];
      const timer = setTimeout(() => socket.close(1008, "Session limit reached"), 125_000);
      const send = (data: WebSocket.RawData, binary: boolean) => {
        if (native && !binary) {
          if (JSON.parse(data.toString()).type === "CloseStream") upstream.send(Buffer.alloc(0));
        } else upstream.send(data, { binary });
      };
      socket.on("message", (data, binary) => {
        size += Array.isArray(data)
          ? data.reduce((total, item) => total + item.length, 0)
          : data.byteLength;
        if (size > 1024 * 1024) return socket.close(1009, "Audio limit exceeded");
        if (!binary) {
          try {
            const message: unknown = JSON.parse(data.toString());
            if (
              !message ||
              typeof message !== "object" ||
              !("type" in message) ||
              !["CloseStream", "KeepAlive"].includes(String(message.type))
            )
              return socket.close(1008, "Invalid transcription control");
          } catch {
            return socket.close(1008, "Invalid transcription control");
          }
        }
        if (upstream.readyState === WebSocket.OPEN) send(data, binary);
        else if (upstream.readyState === WebSocket.CONNECTING) pending.push({ data, binary });
      });
      upstream.on("open", () => {
        for (const item of pending) send(item.data, item.binary);
        pending.length = 0;
      });
      upstream.on("message", (data, binary) => {
        if (socket.readyState !== WebSocket.OPEN) return;
        if (!native) return socket.send(data, { binary });
        try {
          const result = whisperLiveKitResult(data.toString());
          if (result === "done") socket.close(1000);
          else if (result) socket.send(result);
        } catch {
          socket.close(1011, "Transcription unavailable");
        }
      });
      upstream.on("error", () => socket.close(1011, "Transcription unavailable"));
      upstream.on("close", (code) => socket.close(code === 1000 ? 1000 : 1011));
      socket.on("error", () => upstream.terminate());
      socket.on("close", () => {
        clearTimeout(timer);
        clients.delete(socket);
        upstream.terminate();
      });
    },
  );
}
