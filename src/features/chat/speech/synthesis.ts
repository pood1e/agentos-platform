import type { SpeechSynthesisAdapter } from "@assistant-ui/react";
import type { consoleClient } from "../../../lib/console.js";
import { errorKey } from "../../../lib/errors.js";
import { streamAudio } from "./audio-stream.js";
import { PcmPlayback } from "./pcm-playback.js";
import { speechText } from "./text.js";

type Client = Pick<typeof consoleClient, "synthesizeSpeech">;

export class RemoteSpeechAdapter implements SpeechSynthesisAdapter {
  private current?: SpeechSynthesisAdapter.Utterance;
  private context?: AudioContext;

  constructor(
    private client: Client,
    private onError: (key: string) => void,
    private beforeSpeak?: () => void,
  ) {}

  speak(text: string): SpeechSynthesisAdapter.Utterance {
    this.beforeSpeak?.();
    this.current?.cancel();
    const controller = new AbortController();
    const subscribers = new Set<() => void>();
    if (typeof AudioContext !== "undefined") this.context ??= new AudioContext();
    const context = this.context;
    const ready = context?.resume();
    // Observe resume failures immediately; generation reports the same failure through the UI.
    void ready?.catch(() => {});
    let pcm: PcmPlayback | undefined;
    let audio: HTMLAudioElement | undefined;
    let url: string | undefined;
    const finish = (reason: "finished" | "cancelled" | "error") => {
      if (utterance.status.type === "ended") return;
      utterance.status = { type: "ended", reason };
      audio?.pause();
      if (audio) audio.removeAttribute("src");
      if (url) URL.revokeObjectURL(url);
      controller.abort();
      for (const listener of subscribers) listener();
    };
    const utterance: SpeechSynthesisAdapter.Utterance = {
      status: { type: "starting" },
      cancel: () => finish("cancelled"),
      subscribe: (callback) => {
        subscribers.add(callback);
        return () => subscribers.delete(callback);
      },
    };
    const failed = () => {
      if (controller.signal.aborted) return;
      this.onError("speech.playbackFailed");
      finish("error");
    };
    this.current = utterance;
    const generate = async () => {
      try {
        if (ready) await ready;
        controller.signal.throwIfAborted();
        const input = speechText(text);
        if (!input) return finish("finished");
        const responses = this.client.synthesizeSpeech(
          { text: input },
          { signal: controller.signal, timeoutMs: 65_000 },
        );
        const playing = () => {
          if (controller.signal.aborted) return;
          utterance.status = { type: "running" };
          for (const listener of subscribers) listener();
        };
        await streamAudio(
          responses,
          controller.signal,
          (source) => {
            url = source;
            audio = new Audio(source);
            audio.addEventListener("ended", () => finish("finished"));
            audio.addEventListener("error", failed);
            void audio.play().then(playing).catch(failed);
          },
          context
            ? (rate) => {
                pcm = new PcmPlayback(context, rate, controller.signal, playing);
                return pcm;
              }
            : undefined,
        );
        if (pcm) finish("finished");
      } catch (error) {
        if (controller.signal.aborted) return;
        this.onError(errorKey(error, "speech.playbackFailed"));
        finish("error");
      }
    };
    void generate();
    return utterance;
  }

  dispose() {
    this.current?.cancel();
    void this.context?.close().catch(() => {});
    this.context = undefined;
  }
}
