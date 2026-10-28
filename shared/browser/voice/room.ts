import { fromBinary, type MessageInitShape } from "@bufbuild/protobuf";
import type { Client } from "@connectrpc/connect";
import { type AudioCaptureOptions, Room, RoomEvent } from "livekit-client";
import type { ConsoleService } from "../../../gen/agentos/console/v1/console_service_pb.js";
import type { StartVoiceSessionRequestSchema } from "../../../gen/agentos/console/v1/speech_pb.js";
import { type VoiceEvent, VoiceEventSchema } from "../../../gen/agentos/voice/v1/voice_pb.js";

export type VoiceClient = Pick<Client<typeof ConsoleService>, "startVoiceSession">;

// Echo cancellation stays on; browser denoising and gain control alter the speech signal.
export const microphone: AudioCaptureOptions = {
  echoCancellation: true,
  noiseSuppression: false,
  autoGainControl: false,
};

/**
 * Starts a voice session and connects the room to it. `prepare` runs meanwhile, such as the
 * microphone whose pre-connect buffer keeps speech until the agent joins.
 */
export async function joinVoice(
  room: Room,
  client: VoiceClient,
  request: MessageInitShape<typeof StartVoiceSessionRequestSchema>,
  signal: AbortSignal,
  prepare?: Promise<unknown>,
) {
  const [session] = await Promise.all([
    client.startVoiceSession(request, { signal, timeoutMs: 15_000 }),
    prepare,
  ]);
  signal.throwIfAborted();
  await room.connect(session.url, session.token);
  signal.throwIfAborted();
  // A room the agent has not joined after dispatch fails like a dropped connection.
  const dispatch = setTimeout(() => {
    if (![...room.remoteParticipants.values()].some((participant) => participant.isAgent))
      void room.disconnect();
  }, 15_000);
  room.once(RoomEvent.Disconnected, () => clearTimeout(dispatch));
}

export const voiceRoom = () => new Room({ audioCaptureDefaults: microphone });

/** Worker events of the session. */
export function voiceEvents(room: Room, handle: (event: VoiceEvent["event"]) => void) {
  room.on(RoomEvent.DataReceived, (payload, participant, _kind, topic) => {
    if (topic === "agentos.voice" && participant?.isAgent)
      handle(fromBinary(VoiceEventSchema, payload).event);
  });
}

function joinText(prefix: string, suffix: string) {
  if (!prefix || !suffix) return prefix || suffix;
  const separator =
    /\p{Script=Han}$/u.test(prefix) || /^[\p{P}\p{Script=Han}]/u.test(suffix) ? "" : " ";
  return prefix + separator + suffix;
}

/** The local speaker's transcript from LiveKit transcription streams, kept until `reset`. */
export function transcripts(room: Room, changed: (text: string, final: boolean) => void) {
  const segments = new Map<string, string>();
  room.registerTextStreamHandler("lk.transcription", async (reader, participant) => {
    if (participant.identity !== room.localParticipant.identity) return;
    const attributes = reader.info.attributes ?? {};
    segments.set(attributes["lk.segment_id"] ?? reader.info.id, await reader.readAll());
    changed(
      [...segments.values()].reduce(joinText, ""),
      attributes["lk.transcription_final"] === "true",
    );
  });
  return () => segments.clear();
}
