import type { SpeechSynthesisAdapter } from "@assistant-ui/react";
import { DisconnectReason, RoomEvent, Track } from "livekit-client";
import { VoiceMode } from "../../../gen/agentos/console/v1/speech_pb.js";
import { errorKey } from "../../errors.js";
import { joinVoice, type VoiceClient, voiceRoom } from "./room.js";

/** Reads answers aloud through a listen-only voice session per utterance. */
export class VoiceSpeechAdapter implements SpeechSynthesisAdapter {
  private current?: SpeechSynthesisAdapter.Utterance;

  constructor(
    private client: VoiceClient,
    private onError: (key: string) => void,
    private beforeSpeak?: () => void,
  ) {}

  speak(text: string): SpeechSynthesisAdapter.Utterance {
    this.beforeSpeak?.();
    this.current?.cancel();
    const controller = new AbortController();
    const subscribers = new Set<() => void>();
    const room = voiceRoom();
    // Unlocks playback while the click still counts as a user gesture.
    void room.startAudio().catch(() => {});
    const update = (status: SpeechSynthesisAdapter.Status) => {
      if (utterance.status.type === "ended") return;
      utterance.status = status;
      if (status.type === "ended") {
        controller.abort();
        void room.disconnect();
      }
      for (const listener of subscribers) listener();
    };
    const utterance: SpeechSynthesisAdapter.Utterance = {
      status: { type: "starting" },
      cancel: () => update({ type: "ended", reason: "cancelled" }),
      subscribe: (callback) => {
        subscribers.add(callback);
        return () => subscribers.delete(callback);
      },
    };
    const failed = (key = "speech.playbackFailed") => {
      if (utterance.status.type === "ended") return;
      this.onError(key);
      update({ type: "ended", reason: "error" });
    };
    room.on(RoomEvent.TrackSubscribed, (track) => {
      if (track.kind !== Track.Kind.Audio) return;
      track.attach();
      update({ type: "running" });
    });
    room.on(RoomEvent.TrackUnsubscribed, (track) => {
      track.detach();
    });
    // The worker closes the room after playback.
    room.on(RoomEvent.Disconnected, (reason) => {
      if (reason === DisconnectReason.ROOM_DELETED && utterance.status.type === "running")
        update({ type: "ended", reason: "finished" });
      else failed();
    });
    this.current = utterance;
    joinVoice(room, this.client, { mode: VoiceMode.READ_ALOUD, text }, controller.signal).catch(
      (error: unknown) => {
        if (!controller.signal.aborted) failed(errorKey(error, "speech.playbackFailed"));
      },
    );
    return utterance;
  }

  dispose() {
    this.current?.cancel();
  }
}
