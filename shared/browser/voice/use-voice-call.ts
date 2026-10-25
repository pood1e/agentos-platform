import { create, fromJsonString, toJsonString } from "@bufbuild/protobuf";
import type { Client } from "@connectrpc/connect";
import {
  createLocalAudioTrack,
  type LocalAudioTrack,
  Room,
  RoomEvent,
  Track,
} from "livekit-client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ConsoleService } from "../../../gen/agentos/console/v1/console_service_pb.js";
import type { GetSpeechCapabilitiesResponse } from "../../../gen/agentos/console/v1/speech_pb.js";
import { VoiceEventSchema, VoiceReplySchema } from "../../../gen/agentos/voice/v1/worker_pb.js";
import { errorKey } from "../../errors.js";
import { speechLanguage } from "../../speech-language.js";
import { type VoiceChat, VoiceChatBridge } from "./chat-bridge.js";

const topic = "agentos.voice";
type Session = {
  id: string;
  contextId: string;
  scope: string;
  controller: AbortController;
  room: Room;
  microphone?: LocalAudioTrack;
  bridge: VoiceChatBridge;
};
type Phase = "idle" | "connecting" | "listening" | "speaking";

export function useVoiceCall(
  chat: VoiceChat,
  options: {
    contextId: string;
    scope: string;
    language: string;
    capabilities?: GetSpeechCapabilitiesResponse;
    client: Pick<Client<typeof ConsoleService>, "startVoiceCall" | "endVoiceCall">;
    report: (key: string) => void;
  },
) {
  const { contextId, scope, language, capabilities, client: consoleClient, report } = options;
  const current = useRef<Session | undefined>(undefined);
  const latest = useRef(chat);
  latest.current = chat;
  const [room, setRoom] = useState<Room>();
  const [phase, setPhase] = useState<Phase>("idle");
  const [muted, setMuted] = useState(false);
  const [draft, setDraft] = useState("");
  const [queue, setQueue] = useState({ count: 0, failed: false });
  const [unsent, setUnsent] = useState("");
  const stop = useCallback(async () => {
    const session = current.current;
    if (!session) return;
    current.current = undefined;
    setUnsent(session.bridge.close());
    session.controller.abort();
    session.microphone?.stop();
    setRoom(undefined);
    setPhase("idle");
    setDraft("");
    setQueue({ count: 0, failed: false });
    await Promise.allSettled([
      session.room.disconnect(),
      consoleClient.endVoiceCall({ callId: session.id }, { timeoutMs: 15_000 }),
    ]);
  }, [consoleClient]);

  useEffect(() => {
    const session = current.current;
    if (!session) return;
    if (session.scope !== scope) {
      void stop();
      return;
    }
    if (session.contextId !== contextId) {
      const outgoing = chat.outgoing;
      if (
        !session.contextId &&
        outgoing?.contextId === contextId &&
        session.bridge.ownsMessage(outgoing.id)
      )
        session.contextId = contextId;
      else {
        void stop();
        return;
      }
    }
    session.bridge.update(chat);
  }, [chat, contextId, scope, stop]);
  useEffect(
    () => () => {
      void stop();
    },
    [stop],
  );

  const start = async () => {
    if (current.current || !capabilities?.voiceCalls) return;
    const controller = new AbortController();
    const active = () => current.current?.controller === controller && !controller.signal.aborted;
    const voice = new Room();
    const synthesisLanguages: string[] = [];
    const failed = () => {
      if (active()) {
        report("speech.callFailed");
        void stop();
      }
    };
    const bridge = new VoiceChatBridge(
      (turnId, text) => {
        const payload = toJsonString(
          VoiceReplySchema,
          create(VoiceReplySchema, {
            turnId,
            text,
            languageCode: speechLanguage(text, synthesisLanguages),
          }),
        );
        void voice.localParticipant
          .publishData(new TextEncoder().encode(payload), {
            topic,
            reliable: true,
            destinationIdentities: ["assistant"],
          })
          .catch(failed);
      },
      (count, failed) => setQueue({ count, failed }),
      report,
    );
    voice.on(RoomEvent.DataReceived, (payload, participant, _kind, receivedTopic) => {
      if (!active() || receivedTopic !== topic || participant?.identity !== "assistant") return;
      try {
        const event = fromJsonString(VoiceEventSchema, new TextDecoder().decode(payload));
        switch (event.event.case) {
          case "inputStarted":
            bridge.interrupt();
            setPhase("listening");
            setDraft("");
            break;
          case "transcript":
            setDraft(event.event.value);
            break;
          case "userTurn":
            setDraft("");
            bridge.add(event.event.value);
            bridge.update(latest.current);
            break;
        }
      } catch {
        failed();
      }
    });
    voice.on(RoomEvent.ParticipantAttributesChanged, (attributes, participant) => {
      if (!active() || participant.identity !== "assistant" || !attributes["lk.agent.state"])
        return;
      setPhase(attributes["lk.agent.state"] === "speaking" ? "speaking" : "listening");
    });
    voice.on(RoomEvent.Disconnected, () => {
      failed();
    });
    voice.on(RoomEvent.ParticipantDisconnected, (participant) => {
      if (participant.identity === "assistant") failed();
    });
    const session: Session = {
      id: crypto.randomUUID(),
      contextId,
      scope,
      controller,
      room: voice,
      bridge,
    };
    current.current = session;
    setRoom(voice);
    setPhase("connecting");
    setMuted(false);
    setUnsent("");
    bridge.update(chat);
    try {
      void voice.startAudio().catch(() => {});
      const microphone = await createLocalAudioTrack({
        echoCancellation: true,
        noiseSuppression: false,
        autoGainControl: false,
      });
      session.microphone = microphone;
      if (controller.signal.aborted) microphone.stop();
      controller.signal.throwIfAborted();
      const languages = capabilities?.transcriptionLanguages ?? [];
      const preferred = language;
      const { connection } = await consoleClient.startVoiceCall(
        {
          callId: session.id,
          languageCode: languages.includes(preferred) ? preferred : "",
        },
        { signal: controller.signal, timeoutMs: 20_000 },
      );
      controller.signal.throwIfAborted();
      if (!connection) throw new Error("Missing voice connection");
      synthesisLanguages.push(...connection.synthesisLanguages);
      await voice.connect(connection.url, connection.token);
      controller.signal.throwIfAborted();
      await voice.localParticipant.publishTrack(microphone, { source: Track.Source.Microphone });
      if (active()) setPhase("listening");
    } catch (error) {
      if (active()) {
        report(
          error instanceof DOMException && error.name === "NotAllowedError"
            ? "speech.microphoneDenied"
            : errorKey(error, "speech.callFailed"),
        );
        await stop();
      }
    }
  };
  return {
    available: capabilities?.voiceCalls === true,
    active: phase !== "idle",
    room,
    phase,
    muted,
    draft,
    queue,
    unsent,
    start,
    stop: () => void stop(),
    retry: () => current.current?.bridge.retry(),
    toggleMute: () => {
      const session = current.current;
      if (!session) return;
      void session.room.localParticipant
        .setMicrophoneEnabled(muted)
        .then(() => {
          if (current.current === session) setMuted(!muted);
        })
        .catch(() => report("speech.callFailed"));
    },
  };
}

export type VoiceCall = ReturnType<typeof useVoiceCall>;
