import type { DictationAdapter } from "@assistant-ui/react";
import { RoomEvent } from "livekit-client";
import { VoiceMode } from "../../../gen/agentos/console/v1/speech_pb.js";
import { errorKey } from "../../errors.js";
import {
  joinVoice,
  microphone,
  transcripts,
  type VoiceClient,
  voiceEvents,
  voiceRoom,
} from "./room.js";

type Result = DictationAdapter.Result;
export type DictationPhase = "idle" | "starting" | "recording" | "processing";
type Options = { language?: string; onPhase?: (phase: DictationPhase) => void };

// The worker ends a dictation after 1.4 s of silence, 12 s without speech or 60 s in total.
class Dictation implements DictationAdapter.Session {
  status: DictationAdapter.Status = { type: "starting" };
  private controller = new AbortController();
  private room = voiceRoom();
  private started = new Set<() => void>();
  private speech = new Set<(result: Result) => void>();
  private ended = new Set<(result: Result) => void>();
  private complete!: () => void;
  private completion = new Promise<void>((resolve) => {
    this.complete = resolve;
  });
  private timer?: ReturnType<typeof setTimeout>;
  private stopping = false;

  constructor(
    private client: VoiceClient,
    private onError: (key: string) => void,
    private options: Options,
  ) {
    this.options.onPhase?.("starting");
    void this.start();
  }

  private async start() {
    const room = this.room;
    transcripts(room, (transcript) => {
      for (const listener of this.speech) listener({ transcript, isFinal: false });
    });
    voiceEvents(room, (event) => {
      if (event.case === "transcript") this.finish("stopped", event.value);
    });
    room.on(RoomEvent.Disconnected, () => this.failed());
    room.on(RoomEvent.ParticipantDisconnected, (participant) => {
      if (participant.isAgent) this.failed();
    });
    try {
      await joinVoice(
        room,
        this.client,
        { mode: VoiceMode.DICTATION, languageCode: this.options.language ?? "" },
        this.controller.signal,
        room.localParticipant.setMicrophoneEnabled(true, microphone, { preConnectBuffer: true }),
      );
    } catch (error) {
      return this.failed(
        error instanceof DOMException && error.name === "NotAllowedError"
          ? "speech.microphoneDenied"
          : errorKey(error, "speech.transcriptionFailed"),
      );
    }
    this.status = { type: "running" };
    this.options.onPhase?.("recording");
    for (const listener of this.started) listener();
  }

  private finish(reason: "stopped" | "cancelled" | "error", transcript = "") {
    if (this.status.type === "ended") return;
    this.status = { type: "ended", reason };
    clearTimeout(this.timer);
    this.controller.abort();
    void this.room.disconnect();
    this.complete();
    this.options.onPhase?.("idle");
    if (reason === "stopped")
      for (const listener of this.speech) listener({ transcript, isFinal: true });
    for (const listener of this.ended) listener({ transcript });
  }

  private failed(key = "speech.transcriptionFailed") {
    if (this.status.type === "ended") return;
    this.onError(key);
    this.finish("error");
  }

  stop = () => {
    if (this.status.type !== "running") this.cancel();
    if (this.status.type === "ended" || this.stopping) return this.completion;
    this.stopping = true;
    this.options.onPhase?.("processing");
    // Muting ends the turn; the worker flushes transcription and sends the final text.
    void this.room.localParticipant.setMicrophoneEnabled(false).catch(() => this.failed());
    this.timer = setTimeout(() => this.failed("speech.transcriptionTimeout"), 15_000);
    return this.completion;
  };

  cancel = () => this.finish("cancelled");

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

export class VoiceDictationAdapter implements DictationAdapter {
  disableInputDuringDictation = true;
  private current?: Dictation;

  constructor(
    private client: VoiceClient,
    private onError: (key: string) => void,
    private options: Options = {},
  ) {}

  static isSupported() {
    return !!globalThis.navigator?.mediaDevices?.getUserMedia;
  }

  listen() {
    this.current?.cancel();
    this.current = new Dictation(this.client, this.onError, this.options);
    return this.current;
  }

  dispose() {
    this.current?.cancel();
  }
}
