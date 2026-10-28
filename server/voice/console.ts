import { randomUUID } from "node:crypto";
import { Code, type ServiceImpl } from "@connectrpc/connect";
import {
  AccessToken,
  RoomAgentDispatch,
  type RoomServiceClient,
  TrackSource,
} from "livekit-server-sdk";
import type { ConsoleService } from "../../gen/agentos/console/v1/console_service_pb.js";
import { VoiceMode } from "../../gen/agentos/console/v1/speech_pb.js";
import { speechText } from "../../shared/speech-text.js";
import type { KagentClients } from "../kagent/clients.js";
import { requestIdentity } from "../platform/access.js";
import { fail, invalid, precondition, unavailable } from "../shared/errors.js";
import { speechLanguage } from "./language.js";
import type { SpeechSource } from "./settings.js";
import type { VoiceTickets } from "./tickets.js";

/** The LiveKit server browsers join and the agent its rooms dispatch. */
export interface VoiceRooms {
  url: string;
  apiKey: string;
  apiSecret: string;
  agent: string;
  createRoom: RoomServiceClient["createRoom"];
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
  tickets: VoiceTickets,
  rooms: VoiceRooms,
  clients: KagentClients,
  agent: { namespace: string; name: string },
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
      const id = randomUUID();
      let contextId = mode === VoiceMode.CALL ? request.contextId : "";
      let nativeSessionCredential = "";
      let deadline: number | undefined;
      if (mode === VoiceMode.CALL) {
        if (!(await clients.execution.getDelegationCredentialStatus({})).renewable)
          throw precondition("delegation.required");
        const { session } = contextId
          ? await clients.sessions.getSession({ sessionId: contextId })
          : await clients.sessions.createSession(
              { agent, requestId: id, name: "Voice conversation" },
              { timeoutMs: 30_000 },
            );
        if (
          !session ||
          session.agent?.namespace !== agent.namespace ||
          session.agent.name !== agent.name
        )
          throw fail(Code.PermissionDenied, "chat.executionDenied");
        contextId = session.id;
        const credential = await clients.execution.issueSessionCredential({
          sessionId: contextId,
          ttl: { seconds: 1800n },
        });
        nativeSessionCredential = credential.credential;
        deadline = Number(credential.expiresAt?.seconds);
        if (!nativeSessionCredential || !deadline) throw unavailable();
      }
      const { token } = await tickets.create(
        {
          id,
          subject: identity.subject,
          mode,
          languageCode,
          text,
          contextId,
          nativeSessionCredential,
        },
        deadline,
      );
      try {
        await rooms.createRoom({
          name: id,
          maxParticipants: 2,
          emptyTimeout: 60,
          agents: [new RoomAgentDispatch({ agentName: rooms.agent, metadata: token })],
        });
      } catch {
        throw unavailable();
      }
      return { url: rooms.url, token: await roomToken(id, mode) };
    },
  };
}
