import type { DictationAdapter } from "@assistant-ui/react";
import { create } from "@bufbuild/protobuf";
import type { CallOptions } from "@connectrpc/connect";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SynthesizeSpeechResponseSchema } from "../gen/agentos/console/v1/speech_pb.js";
import type { TranscriptionConnection } from "../src/features/chat/speech/connection.js";
import { RemoteDictationAdapter } from "../src/features/chat/speech/dictation.js";
import { detectSpeechEnd } from "../src/features/chat/speech/endpointing.js";
import { RemoteSpeechAdapter } from "../src/features/chat/speech/synthesis.js";
import { until } from "./harness.js";

vi.mock("../src/features/chat/speech/endpointing.js", () => ({
  detectSpeechEnd: vi.fn(async () => ({ start: vi.fn(async () => {}), stop: vi.fn() })),
}));

const recorders: Recorder[] = [];
const players: Player[] = [];
const track = { stop: vi.fn() };
const stream = { getTracks: () => [track] } as unknown as MediaStream;
const report = vi.fn<(key: string) => void>();
class Recorder extends EventTarget {
  static isTypeSupported() {
    return true;
  }
  state = "inactive";
  mimeType = "audio/webm";
  constructor() {
    super();
    recorders.push(this);
  }
  start() {
    this.state = "recording";
  }
  append(blob = new Blob(["recorded audio"])) {
    this.dispatchEvent(Object.assign(new Event("dataavailable"), { data: blob }));
  }
  stop() {
    this.state = "inactive";
    queueMicrotask(() => {
      this.append();
      this.dispatchEvent(new Event("stop"));
    });
  }
}
class Player extends EventTarget {
  play = vi.fn(async () => {});
  pause = vi.fn();
  removeAttribute = vi.fn();
  constructor(readonly src: string) {
    super();
    players.push(this);
  }
}
function pending<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
function connection() {
  const target = new EventTarget();
  const socket = {
    on: vi.fn((type: string, callback: (event: unknown) => void) => {
      target.addEventListener(type, (event) => callback((event as CustomEvent).detail));
    }),
    connect: vi.fn(() => queueMicrotask(() => target.dispatchEvent(new CustomEvent("open")))),
    close: vi.fn(),
    sendMedia: vi.fn(),
    sendCloseStream: vi.fn(() =>
      queueMicrotask(() =>
        target.dispatchEvent(new CustomEvent("close", { detail: { code: 1000 } })),
      ),
    ),
  };
  return {
    ...socket,
    emit: (type: string, detail: unknown) =>
      target.dispatchEvent(new CustomEvent(type, { detail })),
    open: vi.fn(async (_signal: AbortSignal) => socket as unknown as TranscriptionConnection),
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  recorders.length = 0;
  players.length = 0;
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: vi.fn(async () => stream) } });
  vi.stubGlobal("MediaRecorder", Recorder);
  vi.stubGlobal("Audio", Player);
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:agentos-speech");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it("streams audio and revised text before stop, then drains the final recording without sending chat", async () => {
  const socket = connection();
  const session = new RemoteDictationAdapter(report, socket.open).listen();
  const speech = vi.fn<(value: DictationAdapter.Result) => void>();
  session.onSpeech(speech);
  await until(() => recorders.length === 1);
  recorders[0]?.append();
  expect(socket.sendMedia).toHaveBeenCalledOnce();
  for (const [transcript, is_final] of [
    ["检查", false],
    ["检查交换机", false],
    ["检查交换机", true],
  ] as const)
    socket.emit("message", {
      type: "Results",
      is_final,
      channel: { alternatives: [{ transcript }] },
    });
  expect(speech).toHaveBeenNthCalledWith(1, { transcript: "检查", isFinal: false });
  expect(speech).toHaveBeenLastCalledWith({ transcript: "检查交换机", isFinal: false });
  expect(session.status).toEqual({ type: "running" });
  const stopping = session.stop();
  session.stop();
  await stopping;
  expect(socket.sendMedia).toHaveBeenCalledTimes(2);
  expect(socket.sendCloseStream).toHaveBeenCalledOnce();
  expect(track.stop).toHaveBeenCalled();
  expect(socket.close).toHaveBeenCalledOnce();
  expect(session.status).toEqual({ type: "ended", reason: "stopped" });
  expect(report).not.toHaveBeenCalled();
});
it("replaces the complete dictation draft across finalized ranges without inserting spaces in Chinese", async () => {
  const socket = connection();
  const session = new RemoteDictationAdapter(report, socket.open).listen();
  const speech = vi.fn();
  session.onSpeech(speech);
  await until(() => recorders.length === 1);
  for (const [transcript, is_final] of [
    ["检查", true],
    ["交换机", false],
    ["交换机", true],
    ["。", true],
    ["继续", false],
  ] as const)
    socket.emit("message", {
      type: "Results",
      is_final,
      channel: { alternatives: [{ transcript }] },
    });
  expect(speech).toHaveBeenLastCalledWith({ transcript: "检查交换机。继续", isFinal: false });
  await session.stop();
  expect(speech).toHaveBeenLastCalledWith({ transcript: "检查交换机。继续", isFinal: true });
});

it("automatically drains the last audio and transcript when the speaker finishes", async () => {
  const socket = connection();
  const phase = vi.fn();
  const session = new RemoteDictationAdapter(report, socket.open, { onPhase: phase }).listen();
  const ended = vi.fn();
  session.onSpeechEnd(ended);
  await until(() => recorders.length === 1);
  socket.emit("message", {
    type: "Results",
    channel: { alternatives: [{ transcript: "检查交换机" }] },
  });
  const endpoint = vi.mocked(detectSpeechEnd).mock.calls.at(-1)?.[2];
  expect(endpoint).toBeDefined();
  endpoint?.();
  endpoint?.();
  await until(() => session.status.type === "ended");
  expect(socket.sendMedia).toHaveBeenCalledOnce();
  expect(socket.sendCloseStream).toHaveBeenCalledOnce();
  expect(ended).toHaveBeenCalledExactlyOnceWith({ transcript: "检查交换机" });
  expect(phase.mock.calls.map(([value]) => value)).toEqual([
    "starting",
    "recording",
    "processing",
    "idle",
  ]);
  expect(report).not.toHaveBeenCalled();
});

it("exposes processing and allows cancellation without accepting late results", async () => {
  const socket = connection();
  socket.sendCloseStream.mockImplementation(() => {});
  const phase = vi.fn();
  const session = new RemoteDictationAdapter(report, socket.open, {
    language: "ar",
    onPhase: phase,
  }).listen();
  const speech = vi.fn();
  session.onSpeech(speech);
  await until(() => recorders.length === 1);
  expect(socket.open).toHaveBeenCalledWith(expect.any(AbortSignal), "ar");
  const done = session.stop();
  expect(phase).toHaveBeenLastCalledWith("processing");
  session.cancel();
  await done;
  socket.emit("message", {
    type: "Results",
    is_final: true,
    channel: { alternatives: [{ transcript: "late" }] },
  });
  expect(phase).toHaveBeenLastCalledWith("idle");
  expect(speech).not.toHaveBeenCalled();
  expect(report).not.toHaveBeenCalled();
});

it("bounds final transcription waiting and restores the composer after a stalled provider", async () => {
  vi.useFakeTimers();
  const socket = connection();
  socket.sendCloseStream.mockImplementation(() => {});
  const session = new RemoteDictationAdapter(report, socket.open).listen();
  await vi.advanceTimersByTimeAsync(0);
  const done = session.stop();
  await vi.advanceTimersByTimeAsync(15000);
  await done;
  expect(session.status).toEqual({ type: "ended", reason: "error" });
  expect(report).toHaveBeenCalledExactlyOnceWith("speech.transcriptionTimeout");
});

it("discards microphone permission and connection results after switching conversations", async () => {
  const permission = pending<MediaStream>();
  vi.mocked(navigator.mediaDevices.getUserMedia).mockReturnValue(permission.promise);
  const socket = connection();
  const adapter = new RemoteDictationAdapter(report, socket.open);
  const session = adapter.listen();
  adapter.dispose();
  permission.resolve(stream);
  await until(() => track.stop.mock.calls.length > 0);
  expect(session.status).toEqual({ type: "ended", reason: "cancelled" });
  expect(socket.open).not.toHaveBeenCalled();
});
it("cancels the socket and ignores late transcripts", async () => {
  const socket = connection();
  const adapter = new RemoteDictationAdapter(report, socket.open);
  const session = adapter.listen();
  const speech = vi.fn();
  session.onSpeech(speech);
  await until(() => recorders.length === 1);
  adapter.dispose();
  socket.emit("message", {
    type: "Results",
    is_final: true,
    channel: { alternatives: [{ transcript: "late" }] },
  });
  expect(socket.open.mock.calls[0]?.[0].aborted).toBe(true);
  expect(speech).not.toHaveBeenCalled();
  expect(report).not.toHaveBeenCalled();
});
it("releases the microphone and reports a denied permission", async () => {
  vi.mocked(navigator.mediaDevices.getUserMedia).mockRejectedValue(
    new DOMException("denied", "NotAllowedError"),
  );
  const socket = connection();
  const session = new RemoteDictationAdapter(report, socket.open).listen();
  await until(() => session.status.type === "ended");
  expect(report).toHaveBeenCalledExactlyOnceWith("speech.microphoneDenied");
  expect(socket.open).not.toHaveBeenCalled();
});
it("bounds audio upload size and recording duration", async () => {
  const socket = connection();
  const session = new RemoteDictationAdapter(report, socket.open).listen();
  await until(() => recorders.length === 1);
  recorders[0]?.append(new Blob([new Uint8Array(1024 * 1024 + 1)]));
  expect(session.status.type).toBe("ended");
  expect(track.stop).toHaveBeenCalled();
  expect(report).toHaveBeenCalledExactlyOnceWith("speech.tooLarge");
  vi.useFakeTimers();
  const next = connection();
  const second = new RemoteDictationAdapter(report, next.open).listen();
  await vi.advanceTimersByTimeAsync(60000);
  expect(second.status).toEqual({ type: "ended", reason: "stopped" });
});
it("reports an upstream failure and releases the microphone", async () => {
  const socket = connection();
  const session = new RemoteDictationAdapter(report, socket.open).listen();
  await until(() => recorders.length === 1);
  socket.emit("error", new Error("private provider message"));
  socket.emit("close", { code: 1011 });
  expect(session.status).toEqual({ type: "ended", reason: "error" });
  expect(report).toHaveBeenCalledExactlyOnceWith("speech.transcriptionFailed");
  expect(track.stop).toHaveBeenCalled();
});
it("plays synthesized audio, replaces previous playback and releases audio URLs", async () => {
  const synthesizeSpeech = vi.fn(async function* () {
    yield create(SynthesizeSpeechResponseSchema, {
      audio: { contentType: "audio/wav", data: new Uint8Array([1, 2, 3]) },
    });
  });
  const adapter = new RemoteSpeechAdapter({ synthesizeSpeech }, report);
  const first = adapter.speak("你好 / hello / مرحبا");
  await until(() => first.status.type === "running");
  const second = adapter.speak("second");
  expect(first.status).toEqual({ type: "ended", reason: "cancelled" });
  expect(players[0]?.pause).toHaveBeenCalled();
  await until(() => second.status.type === "running");
  players[1]?.dispatchEvent(new Event("ended"));
  expect(second.status).toEqual({ type: "ended", reason: "finished" });
  expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
  expect(report).not.toHaveBeenCalled();
});

it("cancels pending synthesis and prevents playback after switching conversations", async () => {
  const result = pending<ReturnType<typeof create<typeof SynthesizeSpeechResponseSchema>>>();
  const synthesizeSpeech = vi.fn(async function* (_request: unknown, _options?: CallOptions) {
    yield await result.promise;
  });
  const adapter = new RemoteSpeechAdapter({ synthesizeSpeech }, report);
  const utterance = adapter.speak("pending");
  adapter.dispose();
  expect(synthesizeSpeech.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  result.resolve(
    create(SynthesizeSpeechResponseSchema, {
      audio: { contentType: "audio/wav", data: new Uint8Array([1]) },
    }),
  );
  await Promise.resolve();
  expect(utterance.status).toEqual({ type: "ended", reason: "cancelled" });
  expect(players).toHaveLength(0);
  expect(report).not.toHaveBeenCalled();
});

it("reports playback failures and leaves the adapter ready for another attempt", async () => {
  const synthesizeSpeech = vi.fn(async function* () {
    yield create(SynthesizeSpeechResponseSchema);
  });
  const adapter = new RemoteSpeechAdapter({ synthesizeSpeech }, report);
  const utterance = adapter.speak("test");
  await until(() => utterance.status.type === "ended");
  expect(report).toHaveBeenCalledExactlyOnceWith("speech.playbackFailed");
  expect(utterance.status).toEqual({ type: "ended", reason: "error" });
});

it("begins streaming playback before synthesis finishes and cancels the unfinished request", async () => {
  const remainder = pending<void>();
  const end = vi.fn();
  class Source extends EventTarget {
    static isTypeSupported(type: string) {
      return type === "audio/mpeg";
    }
    constructor() {
      super();
      queueMicrotask(() => this.dispatchEvent(new Event("sourceopen")));
    }
    addSourceBuffer() {
      const buffer = new EventTarget();
      return Object.assign(buffer, {
        appendBuffer() {
          queueMicrotask(() => buffer.dispatchEvent(new Event("updateend")));
        },
      });
    }
    endOfStream = end;
  }
  vi.stubGlobal("MediaSource", Source);
  const synthesizeSpeech = vi.fn(async function* (_request: unknown, _options?: CallOptions) {
    yield create(SynthesizeSpeechResponseSchema, {
      audio: { contentType: "audio/mpeg", data: new Uint8Array([1]) },
    });
    await remainder.promise;
    yield create(SynthesizeSpeechResponseSchema, {
      audio: { contentType: "audio/mpeg", data: new Uint8Array([2]) },
    });
  });
  const adapter = new RemoteSpeechAdapter({ synthesizeSpeech }, report);
  const utterance = adapter.speak("streamed answer");
  await until(() => utterance.status.type === "running");
  expect(end).not.toHaveBeenCalled();
  adapter.dispose();
  expect(synthesizeSpeech.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  remainder.resolve();
  await Promise.resolve();
  expect(utterance.status).toEqual({ type: "ended", reason: "cancelled" });
  expect(report).not.toHaveBeenCalled();
});
