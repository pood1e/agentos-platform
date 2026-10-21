import type { SpeechSynthesisAdapter } from "@assistant-ui/react";
import type { consoleClient } from "../../../lib/console.js";
import { errorKey } from "../../../lib/errors.js";

type Client = Pick<typeof consoleClient, "synthesizeSpeech">;

export class RemoteSpeechAdapter implements SpeechSynthesisAdapter {
  private current?: SpeechSynthesisAdapter.Utterance;

  constructor(
    private client: Client,
    private onError: (key: string) => void,
  ) {}

  speak(text: string): SpeechSynthesisAdapter.Utterance {
    this.current?.cancel();
    const controller = new AbortController();
    const subscribers = new Set<() => void>();
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
    this.current = utterance;
    const generate = async () => {
      try {
        const { audio: result } = await this.client.synthesizeSpeech(
          { text },
          { signal: controller.signal, timeoutMs: 65_000 },
        );
        if (controller.signal.aborted) return;
        if (!result?.data.length) throw new Error("Empty speech response");
        url = URL.createObjectURL(
          new Blob([new Uint8Array(result.data).buffer], { type: result.contentType }),
        );
        audio = new Audio(url);
        audio.addEventListener("ended", () => finish("finished"));
        audio.addEventListener("error", () => {
          this.onError("speech.playbackFailed");
          finish("error");
        });
        await audio.play();
        if (controller.signal.aborted) return;
        utterance.status = { type: "running" };
        for (const listener of subscribers) listener();
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
  }
}
