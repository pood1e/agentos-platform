import { Code, type ServiceImpl } from "@connectrpc/connect";
import { AccessToken, RoomAgentDispatch, RoomConfiguration, TrackSource } from "livekit-server-sdk";
import type { ConsoleService } from "../../gen/agentos/console/v1/console_service_pb.js";
import { VoiceMode } from "../../gen/agentos/console/v1/speech_pb.js";
import { speechText } from "../../shared/speech-text.js";
import type { Executions } from "../authorization/executions.js";
import type { KagentClients } from "../kagent/clients.js";
import { requestIdentity } from "../platform/access.js";
import { fail, invalid, precondition } from "../shared/errors.js";
import { speechLanguage } from "./language.js";
import type { VoiceSessions } from "./sessions.js";
import type { SpeechSource } from "./settings.js";

/** The LiveKit server browsers join and the agent its rooms dispatch. */
export interface VoiceRooms {
  url: string;
  apiKey: string;
  apiSecret: string;
  agent: string;
}

export type VoiceConsole = Pick<
  ServiceImpl<typeof ConsoleService>,
  "getSpeechCapabilities" | "startVoiceSession"
>;

export const voiceDisabled: VoiceConsole = {
  getSpeechCapabilities: () => ({}),
  startVoiceSession: () => {
    throw precondition("speech.unavailable");
  },
};

export function voiceConsole(
  settings: SpeechSource,
  sessions: VoiceSessions,
  rooms: VoiceRooms,
  clients: KagentClients,
  executions: Executions,
): VoiceConsole {
  // Room tokens grant one room; read-aloud participants only listen.
  const roomToken = (id: string, mode: VoiceMode) => {
    const speaks = mode !== VoiceMode.READ_ALOUD;
    const token = new AccessToken(rooms.apiKey, rooms.apiSecret, { identity: "user", ttl: "5m" });
    token.addGrant({
      room: id,
      roomJoin: true,
      canSubscribe: true,
      canPublish: speaks,
      canPublishData: speaks,
      canPublishSources: speaks ? [TrackSource.MICROPHONE] : [],
    });
    token.roomConfig = new RoomConfiguration({
      maxParticipants: 2,
      agents: [new RoomAgentDispatch({ agentName: rooms.agent })],
    });
    return token.toJwt();
  };
  return {
    async getSpeechCapabilities() {
      const { transcription, synthesis } = (await settings()).configuration;
      return {
        enabled: true,
        transcription: !!transcription?.endpoint,
        synthesis: !!synthesis?.endpoint,
        transcriptionLanguages: transcription?.languageCodes ?? [],
      };
    },
    async startVoiceSession(request, context) {
      const identity = context.values.get(requestIdentity);
      const { transcription, synthesis } = (await settings()).configuration;
      const { mode } = request;
      if (
        (mode !== VoiceMode.READ_ALOUD && !transcription?.endpoint) ||
        (mode !== VoiceMode.DICTATION && !synthesis?.endpoint)
      )
        throw precondition("speech.unavailable");
      let { languageCode } = request;
      let text = "";
      if (mode === VoiceMode.READ_ALOUD) {
        text = speechText(request.text);
        if (!text) throw invalid("speech.invalidText");
        languageCode = speechLanguage(
          text,
          synthesis?.voices.map((voice) => voice.languageCode) ?? [],
        );
      } else if (languageCode && !transcription?.languageCodes.includes(languageCode))
        throw invalid("speech.requestRejected");
      const contextId = mode === VoiceMode.CALL ? request.contextId : "";
      if (mode === VoiceMode.CALL && !(await executions.delegated(identity.subject)))
        throw precondition("delegation.required");
      if (contextId) {
        const { session } = await clients.sessions.getSession({ sessionId: contextId });
        if (!session) throw fail(Code.PermissionDenied, "chat.executionDenied");
        await executions.own(session, identity);
      }
      const id = await sessions.create({
        subject: identity.subject,
        mode,
        languageCode,
        text,
        contextId,
      });
      return { url: rooms.url, token: await roomToken(id, mode) };
    },
  };
}
