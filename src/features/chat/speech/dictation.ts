import type { DictationAdapter } from "@assistant-ui/react";
import { openTranscription, type TranscriptionConnection } from "./connection.js";

const maxAudioBytes = 1024 * 1024;
const maxRecordingMs = 60_000;
const mimeTypes = ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus"];
type Result = DictationAdapter.Result;

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
  ) {
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
    for (const listener of this.ended) listener({ transcript });
  }

  private async start() {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (this.controller.signal.aborted) {
        this.releaseMicrophone();
        return;
      }
      this.connection = await this.connect(this.controller.signal);
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
          this.transcript = [this.transcript, text].filter(Boolean).join(" ");
          this.interim = "";
        } else this.interim = text;
        for (const listener of this.speech) listener({ transcript: text, isFinal });
      });
      this.connection.on("error", () => this.failed());
      this.connection.on("close", (event) => {
        if (this.controller.signal.aborted) return;
        if (!this.stopping || event.code !== 1000) return this.failed();
        if (this.interim)
          for (const listener of this.speech) listener({ transcript: this.interim, isFinal: true });
        this.finish("stopped", [this.transcript, this.interim].filter(Boolean).join(" "));
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
          this.timer = setTimeout(() => this.failed(), 60_000);
        }
      });
      this.recorder.addEventListener("error", () => this.failed());
      this.recorder.start(250);
      this.status = { type: "running" };
      this.timer = setTimeout(() => void this.stop(), maxRecordingMs);
      for (const listener of this.started) listener();
    } catch {
      this.failed();
    }
  }

  stop = () => {
    if (this.status.type === "ended" || this.stopping) return this.completion;
    this.stopping = true;
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
  ) {}

  static isSupported() {
    return (
      !!globalThis.navigator?.mediaDevices?.getUserMedia && typeof MediaRecorder !== "undefined"
    );
  }

  listen() {
    this.recording?.cancel();
    this.recording = new Recording(this.onError, this.connect);
    return this.recording;
  }

  dispose() {
    this.recording?.cancel();
  }
}
