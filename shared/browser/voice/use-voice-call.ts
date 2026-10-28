import { DisconnectReason, type Participant, type Room, RoomEvent } from "livekit-client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { GetSpeechCapabilitiesResponse } from "../../../gen/agentos/console/v1/speech_pb.js";
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

type Phase = "idle" | "connecting" | "listening" | "thinking" | "speaking";
type Call = {
  room: Room;
  contextId: string;
  scope: string;
  controller: AbortController;
  joined?: boolean;
};

const phases: Record<string, Phase> = {
  initializing: "connecting",
  listening: "listening",
  thinking: "thinking",
  speaking: "speaking",
};

/**
 * A call with the conversation's agent. The voice worker sends finished turns and speaks the
 * answers; talking interrupts the answer and cancels its task. The call ends when the
 * conversation or identity scope changes.
 */
export function useVoiceCall(options: {
  client: VoiceClient;
  contextId: string;
  scope: string;
  language: string;
  capabilities?: GetSpeechCapabilitiesResponse;
  report: (key: string) => void;
  /** Opens the conversation that the call's first turn started. */
  started: (contextId: string) => void;
}) {
  const { client, contextId, scope, language, capabilities, report, started } = options;
  const current = useRef<Call | undefined>(undefined);
  const [room, setRoom] = useState<Room>();
  const [phase, setPhase] = useState<Phase>("idle");
  const [muted, setMuted] = useState(false);
  const [draft, setDraft] = useState("");
  const stop = useCallback(async () => {
    const call = current.current;
    if (!call) return;
    current.current = undefined;
    call.controller.abort();
    setRoom(undefined);
    setPhase("idle");
    setDraft("");
    await call.room.disconnect();
  }, []);

  useEffect(() => {
    const call = current.current;
    if (call && (call.scope !== scope || call.contextId !== contextId)) void stop();
  }, [contextId, scope, stop]);
  useEffect(
    () => () => {
      void stop();
    },
    [stop],
  );

  const start = async () => {
    if (current.current || !capabilities?.transcription || !capabilities.synthesis) return;
    const call: Call = { room: voiceRoom(), contextId, scope, controller: new AbortController() };
    const active = () => current.current === call;
    const failed = (key = "speech.callFailed") => {
      if (!active()) return;
      report(key);
      void stop();
    };
    const reset = transcripts(call.room, (text, final) => {
      if (!active()) return;
      setDraft(final ? "" : text);
      if (final) reset();
    });
    voiceEvents(call.room, (event) => {
      if (!active()) return;
      if (event.case === "error") report(event.value);
      if (event.case === "contextId") {
        call.contextId = event.value;
        started(event.value);
      }
    });
    const agentState = (participant: Participant) => {
      const state = participant.attributes["lk.agent.state"];
      if (!active() || !participant.isAgent || !state) return;
      call.joined = true;
      setPhase(phases[state] ?? "listening");
    };
    call.room.on(RoomEvent.ParticipantConnected, agentState);
    call.room.on(RoomEvent.ParticipantAttributesChanged, (_changed, participant) =>
      agentState(participant),
    );
    call.room.on(RoomEvent.ParticipantDisconnected, (participant) => {
      if (participant.isAgent) failed();
    });
    // The worker deletes the room when the call reaches its time limit.
    call.room.on(RoomEvent.Disconnected, (reason) => {
      if (reason === DisconnectReason.ROOM_DELETED && call.joined) void stop();
      else failed();
    });
    current.current = call;
    setRoom(call.room);
    setPhase("connecting");
    setMuted(false);
    try {
      void call.room.startAudio().catch(() => {});
      const languages = capabilities.transcriptionLanguages;
      await joinVoice(
        call.room,
        client,
        {
          mode: VoiceMode.CALL,
          contextId,
          languageCode: languages.includes(language) ? language : "",
        },
        call.controller.signal,
        call.room.localParticipant.setMicrophoneEnabled(true, microphone, {
          preConnectBuffer: true,
        }),
      );
    } catch (error) {
      failed(
        error instanceof DOMException && error.name === "NotAllowedError"
          ? "speech.microphoneDenied"
          : errorKey(error, "speech.callFailed"),
      );
    }
  };
  return {
    available: capabilities?.transcription === true && capabilities.synthesis === true,
    active: phase !== "idle",
    room,
    phase,
    muted,
    draft,
    start,
    stop: () => void stop(),
    toggleMute: () => {
      const call = current.current;
      if (!call) return;
      void call.room.localParticipant
        .setMicrophoneEnabled(muted, microphone)
        .then(() => {
          if (current.current === call) setMuted(!muted);
        })
        .catch(() => report("speech.callFailed"));
    },
  };
}

export type VoiceCall = ReturnType<typeof useVoiceCall>;
