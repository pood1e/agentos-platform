import type { DictationAdapter } from "@assistant-ui/react";
import { create } from "@bufbuild/protobuf";
import type { CallOptions } from "@connectrpc/connect";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SynthesizeSpeechResponseSchema } from "../gen/agentos/console/v1/speech_pb.js";
import type { TranscriptionConnection } from "../src/features/chat/speech/connection.js";
import { RemoteDictationAdapter } from "../src/features/chat/speech/dictation.js";
import { RemoteSpeechAdapter } from "../src/features/chat/speech/synthesis.js";
import { until } from "./harness.js";

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
  expect(speech).toHaveBeenLastCalledWith({ transcript: "检查交换机", isFinal: true });
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
  const synthesizeSpeech = vi.fn(async () =>
    create(SynthesizeSpeechResponseSchema, {
      audio: { contentType: "audio/wav", data: new Uint8Array([1, 2, 3]) },
    }),
  );
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
  const synthesizeSpeech = vi.fn(
    async (_request: unknown, _options?: CallOptions) => result.promise,
  );
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
  const synthesizeSpeech = vi.fn(async () => create(SynthesizeSpeechResponseSchema));
  const adapter = new RemoteSpeechAdapter({ synthesizeSpeech }, report);
  const utterance = adapter.speak("test");
  await until(() => utterance.status.type === "ended");
  expect(report).toHaveBeenCalledExactlyOnceWith("speech.playbackFailed");
  expect(utterance.status).toEqual({ type: "ended", reason: "error" });
});
