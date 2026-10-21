import type { DictationAdapter } from "@assistant-ui/react";
import { openTranscription, type TranscriptionConnection } from "./connection.js";

const maxAudioBytes = 1024 * 1024;
const maxRecordingMs = 60_000;
const mimeTypes = ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus"];
type Result = DictationAdapter.Result;
export type DictationPhase = "idle" | "starting" | "recording" | "processing";
type Options = { language?: string; onPhase?: (phase: DictationPhase) => void };

function joinText(prefix: string, suffix: string) {
  if (!prefix || !suffix) return prefix || suffix;
  const separator =
    /\p{Script=Han}$/u.test(prefix) || /^[\p{P}\p{Script=Han}]/u.test(suffix) ? "" : " ";
  return prefix + separator + suffix;
}

class Recording implements DictationAdapter.Session {
  status: DictationAdapter.Status = { type: "starting" };
  private controller = new AbortController();
  private started = new Set<() => void>();
  private speech = new Set<(result: Result) => void>();
  private ended = new Set<(result: Result) => void>();
  private complete!: () => void;
  private completion = new Promise<void>((resolve) => {
    this.complete = resolve;
  });
  private recorder?: MediaRecorder;
  private stream?: MediaStream;
  private timer?: ReturnType<typeof setTimeout>;
  private connection?: TranscriptionConnection;
  private size = 0;
  private stopping = false;
  private transcript = "";
  private interim = "";

  constructor(
    private onError: (key: string) => void,
    private connect: typeof openTranscription,
    private options: Options,
  ) {
    this.options.onPhase?.("starting");
    void this.start();
  }

  private releaseMicrophone() {
    clearTimeout(this.timer);
    for (const track of this.stream?.getTracks() ?? []) track.stop();
  }

  private finish(reason: "stopped" | "cancelled" | "error", transcript = "") {
    if (this.status.type === "ended") return;
    this.status = { type: "ended", reason };
    this.releaseMicrophone();
    this.controller.abort();
    this.connection?.close();
    this.complete();
    this.options.onPhase?.("idle");
    for (const listener of this.ended) listener({ transcript });
  }

  private async start() {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
      if (this.controller.signal.aborted) {
        this.releaseMicrophone();
        return;
      }
      this.connection = await this.connect(this.controller.signal, this.options.language);
      if (this.controller.signal.aborted) {
        this.connection.close();
        return;
      }
      this.connection.on("message", (event) => {
        if (this.controller.signal.aborted) return;
        if (event.type === "Error") return this.failed();
        if (event.type !== "Results") return;
        const text = event.channel.alternatives[0]?.transcript ?? "";
        const isFinal = event.is_final === true;
        if (isFinal) {
          this.transcript = joinText(this.transcript, text);
          this.interim = "";
        } else this.interim = text;
        for (const listener of this.speech)
          listener({ transcript: joinText(this.transcript, this.interim), isFinal: false });
      });
      this.connection.on("error", () => this.failed());
      this.connection.on("close", (event) => {
        if (this.controller.signal.aborted) return;
        if (!this.stopping || event.code !== 1000) return this.failed();
        const transcript = joinText(this.transcript, this.interim);
        for (const listener of this.speech) listener({ transcript, isFinal: true });
        this.finish("stopped", transcript);
      });
      this.connection.on("open", () => this.record());
      this.connection.connect();
    } catch (error) {
      if (this.controller.signal.aborted) return;
      this.failed(
        error instanceof DOMException && error.name === "NotAllowedError"
          ? "speech.microphoneDenied"
          : "speech.transcriptionFailed",
      );
    }
  }

  private failed(key = "speech.transcriptionFailed") {
    if (this.controller.signal.aborted || this.status.type === "ended") return;
    this.onError(key);
    if (this.recorder?.state === "recording") this.recorder.stop();
    this.finish("error");
  }

  private record() {
    if (this.controller.signal.aborted || !this.stream) return;
    try {
      const mimeType = mimeTypes.find((type) => MediaRecorder.isTypeSupported(type));
      this.recorder = new MediaRecorder(this.stream, mimeType ? { mimeType } : undefined);
      this.recorder.addEventListener("dataavailable", ({ data }) => {
        if (this.controller.signal.aborted || !data.size) return;
        this.size += data.size;
        if (this.size > maxAudioBytes) {
          this.onError("speech.tooLarge");
          this.cancel();
          return;
        }
        this.connection?.sendMedia(data);
      });
      this.recorder.addEventListener("stop", () => {
        this.releaseMicrophone();
        if (!this.controller.signal.aborted) {
          this.connection?.sendCloseStream({ type: "CloseStream" });
          this.timer = setTimeout(() => this.failed("speech.transcriptionTimeout"), 15_000);
        }
      });
      this.recorder.addEventListener("error", () => this.failed());
      this.recorder.start(250);
      this.status = { type: "running" };
      this.options.onPhase?.("recording");
      this.timer = setTimeout(() => void this.stop(), maxRecordingMs);
      for (const listener of this.started) listener();
    } catch {
      this.failed();
    }
  }

  stop = () => {
    if (this.status.type === "ended" || this.stopping) return this.completion;
    this.stopping = true;
    this.options.onPhase?.("processing");
    clearTimeout(this.timer);
    if (this.recorder?.state === "recording") this.recorder.stop();
    else this.cancel();
    return this.completion;
  };

  cancel = () => {
    this.controller.abort();
    if (this.recorder?.state === "recording") this.recorder.stop();
    this.finish("cancelled");
  };

  onSpeechStart = (callback: () => void) => {
    this.started.add(callback);
    return () => this.started.delete(callback);
  };
  onSpeech = (callback: (result: Result) => void) => {
    this.speech.add(callback);
    return () => this.speech.delete(callback);
  };
  onSpeechEnd = (callback: (result: Result) => void) => {
    this.ended.add(callback);
    return () => this.ended.delete(callback);
  };
}

export class RemoteDictationAdapter implements DictationAdapter {
  disableInputDuringDictation = true;
  private recording?: Recording;

  constructor(
    private onError: (key: string) => void,
    private connect = openTranscription,
    private options: Options = {},
  ) {}

  static isSupported() {
    return (
      !!globalThis.navigator?.mediaDevices?.getUserMedia && typeof MediaRecorder !== "undefined"
    );
  }

  listen() {
    this.recording?.cancel();
    this.recording = new Recording(this.onError, this.connect, this.options);
    return this.recording;
  }

  dispose() {
    this.recording?.cancel();
  }
}
