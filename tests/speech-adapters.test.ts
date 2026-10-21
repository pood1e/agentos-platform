import type { DictationAdapter } from "@assistant-ui/react";
import { create } from "@bufbuild/protobuf";
import type { CallOptions } from "@connectrpc/connect";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  SynthesizeSpeechResponseSchema,
  TranscribeAudioResponseSchema,
} from "../gen/agentos/console/v1/speech_pb.js";
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

it("commits one transcript, releases the microphone before transcription and never sends a chat message", async () => {
  const result = pending<ReturnType<typeof create<typeof TranscribeAudioResponseSchema>>>();
  const transcribeAudio = vi.fn(
    async (_request: unknown, _options?: CallOptions) => result.promise,
  );
  const adapter = new RemoteDictationAdapter({ transcribeAudio }, report);
  const session = adapter.listen();
  const speech = vi.fn<(value: DictationAdapter.Result) => void>();
  session.onSpeech(speech);
  await until(() => recorders.length === 1);
  const stopping = session.stop();
  session.stop();
  await until(() => transcribeAudio.mock.calls.length === 1);
  expect(track.stop).toHaveBeenCalled();
  expect(speech).not.toHaveBeenCalled();
  result.resolve(create(TranscribeAudioResponseSchema, { text: "افحص المحول / 检查交换机" }));
  await stopping;
  expect(speech).toHaveBeenCalledExactlyOnceWith({
    transcript: "افحص المحول / 检查交换机",
    isFinal: true,
  });
  expect(session.status).toEqual({ type: "ended", reason: "stopped" });
  expect(report).not.toHaveBeenCalled();
});

it("discards late microphone permission results after leaving the conversation", async () => {
  const permission = pending<MediaStream>();
  vi.mocked(navigator.mediaDevices.getUserMedia).mockReturnValue(permission.promise);
  const transcribeAudio = vi.fn(async () => create(TranscribeAudioResponseSchema));
  const adapter = new RemoteDictationAdapter({ transcribeAudio }, report);
  const session = adapter.listen();
  adapter.dispose();
  permission.resolve(stream);
  await until(() => track.stop.mock.calls.length > 0);
  expect(session.status).toEqual({ type: "ended", reason: "cancelled" });
  expect(recorders).toHaveLength(0);
  expect(transcribeAudio).not.toHaveBeenCalled();
});

it("aborts a pending transcription and ignores its late result", async () => {
  const result = pending<ReturnType<typeof create<typeof TranscribeAudioResponseSchema>>>();
  const transcribeAudio = vi.fn(
    async (_request: unknown, _options?: CallOptions) => result.promise,
  );
  const adapter = new RemoteDictationAdapter({ transcribeAudio }, report);
  const session = adapter.listen();
  const speech = vi.fn();
  session.onSpeech(speech);
  await until(() => recorders.length === 1);
  void session.stop();
  await until(() => transcribeAudio.mock.calls.length > 0);
  adapter.dispose();
  expect(transcribeAudio.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  result.resolve(create(TranscribeAudioResponseSchema, { text: "late transcript" }));
  await Promise.resolve();
  expect(speech).not.toHaveBeenCalled();
  expect(report).not.toHaveBeenCalled();
});

it("ends a denied microphone request with an actionable error", async () => {
  vi.mocked(navigator.mediaDevices.getUserMedia).mockRejectedValue(
    new DOMException("denied", "NotAllowedError"),
  );
  const transcribeAudio = vi.fn(async () => create(TranscribeAudioResponseSchema));
  const session = new RemoteDictationAdapter({ transcribeAudio }, report).listen();
  await until(() => session.status.type === "ended");
  expect(report).toHaveBeenCalledExactlyOnceWith("speech.microphoneDenied");
  expect(transcribeAudio).not.toHaveBeenCalled();
});

it("bounds recording size and releases the microphone when the limit is exceeded", async () => {
  const transcribeAudio = vi.fn(async () => create(TranscribeAudioResponseSchema));
  const session = new RemoteDictationAdapter({ transcribeAudio }, report).listen();
  await until(() => recorders.length === 1);
  recorders[0]?.append(new Blob([new Uint8Array(1024 * 1024 + 1)]));
  expect(session.status.type).toBe("ended");
  expect(track.stop).toHaveBeenCalled();
  expect(report).toHaveBeenCalledExactlyOnceWith("speech.tooLarge");
  expect(transcribeAudio).not.toHaveBeenCalled();
});

it("automatically stops a recording after one minute", async () => {
  vi.useFakeTimers();
  const transcribeAudio = vi.fn(async () =>
    create(TranscribeAudioResponseSchema, { text: "bounded" }),
  );
  const session = new RemoteDictationAdapter({ transcribeAudio }, report).listen();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(transcribeAudio).toHaveBeenCalledOnce();
  expect(session.status).toEqual({ type: "ended", reason: "stopped" });
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
