import type { DictationAdapter } from "@assistant-ui/react";
import type { consoleClient } from "../../../lib/console.js";
import { errorKey } from "../../../lib/errors.js";

const maxAudioBytes = 1024 * 1024;
const maxRecordingMs = 60_000;
const mimeTypes = ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus"];
type Client = Pick<typeof consoleClient, "transcribeAudio">;
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
  private chunks: Blob[] = [];
  private size = 0;
  private stopping = false;

  constructor(
    private client: Client,
    private onError: (key: string) => void,
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
    this.chunks = [];
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
        this.chunks.push(data);
      });
      this.recorder.addEventListener("stop", () => void this.transcribe());
      this.recorder.addEventListener("error", () => {
        this.onError("speech.transcriptionFailed");
        this.cancel();
      });
      this.recorder.start(250);
      this.status = { type: "running" };
      this.timer = setTimeout(() => void this.stop(), maxRecordingMs);
      for (const listener of this.started) listener();
    } catch (error) {
      if (this.controller.signal.aborted) return;
      this.onError(
        error instanceof DOMException && error.name === "NotAllowedError"
          ? "speech.microphoneDenied"
          : "speech.transcriptionFailed",
      );
      this.finish("error");
    }
  }

  private async transcribe() {
    this.releaseMicrophone();
    if (this.controller.signal.aborted || this.status.type === "ended") return;
    try {
      const blob = new Blob(this.chunks, { type: this.recorder?.mimeType });
      this.chunks = [];
      if (!blob.size) {
        this.finish("stopped");
        return;
      }
      const result = await this.client.transcribeAudio(
        { audio: { contentType: blob.type, data: new Uint8Array(await blob.arrayBuffer()) } },
        { signal: this.controller.signal, timeoutMs: 65_000 },
      );
      if (this.controller.signal.aborted) return;
      for (const listener of this.speech) listener({ transcript: result.text, isFinal: true });
      this.finish("stopped", result.text);
    } catch (error) {
      if (this.controller.signal.aborted) return;
      this.onError(errorKey(error, "speech.transcriptionFailed"));
      this.finish("error");
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
    private client: Client,
    private onError: (key: string) => void,
  ) {}

  static isSupported() {
    return (
      !!globalThis.navigator?.mediaDevices?.getUserMedia && typeof MediaRecorder !== "undefined"
    );
  }

  listen() {
    this.recording?.cancel();
    this.recording = new Recording(this.client, this.onError);
    return this.recording;
  }

  dispose() {
    this.recording?.cancel();
  }
}
