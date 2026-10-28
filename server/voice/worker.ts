import { clone, create } from "@bufbuild/protobuf";
import { Code, ConnectError, type Interceptor, type ServiceImpl } from "@connectrpc/connect";
import { TaskState } from "../../gen/a2a_pb.js";
import { UserIdentitySchema } from "../../gen/agentos/authorization/v1/identity_pb.js";
import { SendMessageRequestSchema } from "../../gen/agentos/console/v1/console_service_pb.js";
import { SpeechConfigurationSchema, VoiceMode } from "../../gen/agentos/console/v1/speech_pb.js";
import {
  GetVoiceAnswerResponseSchema,
  type VoiceService,
  type VoiceSession,
} from "../../gen/agentos/voice/v1/voice_pb.js";
import { speechText } from "../../shared/speech-text.js";
import type { serviceAccountTokens } from "../authorization/workloads.js";
import { messageCommands } from "../console/messages.js";
import { watch } from "../console/watch.js";
import type { KagentClients } from "../kagent/clients.js";
import { nativeHeaders } from "../kagent/context.js";
import type { TaskQueries } from "../read-model/queries.js";
import { terminal } from "../read-model/state.js";
import { TaskStreams } from "../read-model/streams.js";
import { speechLanguage } from "./language.js";
import type { SpeechSource } from "./settings.js";
import type { VoiceTickets } from "./tickets.js";

const denied = () => new ConnectError("Voice session is invalid or expired", Code.PermissionDenied);

/** Admits only the voice worker's service account token. */
export function voiceWorker(
  review: ReturnType<typeof serviceAccountTokens>,
  audience: string,
  subject: string,
): Interceptor {
  return (next) => async (request) => {
    const token = request.header.get("authorization")?.match(/^Bearer ([^\s,]+)$/)?.[1];
    if (!token)
      throw new ConnectError("A signed workload identity is required", Code.Unauthenticated);
    await review(token, audience, [subject]);
    return next(request);
  };
}

export interface VoiceWorkerDependencies {
  settings: SpeechSource;
  gatewayURL: string;
  tickets: VoiceTickets;
  projection: TaskQueries;
  clients: KagentClients;
  /** Calls talk to the entry agent. */
  agent: { namespace: string; name: string };
}

export function voiceService({
  settings,
  gatewayURL,
  tickets,
  projection,
  clients,
  agent,
}: VoiceWorkerDependencies): ServiceImpl<typeof VoiceService> {
  const messages = messageCommands(projection, clients, agent.namespace);
  const voices = async () =>
    (await settings()).configuration.synthesis?.voices.map((voice) => voice.languageCode) ?? [];

  async function session(id: string, token: string, mode?: VoiceMode) {
    const ticket = await tickets.verify(id, token);
    if (mode !== undefined && ticket.session.mode !== mode) throw denied();
    return ticket;
  }
  async function within<T>(value: VoiceSession, run: () => Promise<T>): Promise<T> {
    if (!value.nativeSessionCredential || !value.contextId) throw denied();
    return nativeHeaders.run(
      new Headers({ authorization: `Bearer ${value.nativeSessionCredential}` }),
      async () => {
        const { session } = await clients.sessions.getSession({ sessionId: value.contextId });
        if (!session || session.authority?.initiatorId !== value.subject) throw denied();
        return run();
      },
    );
  }
  // Turns are tasks of the session's own conversation.
  async function turn(value: VoiceSession, taskId: string) {
    const entry = await projection.entry(taskId);
    if (!entry || !value.contextId || entry.contextId !== value.contextId) throw denied();
    return entry;
  }

  return {
    async getVoiceSession({ sessionId, sessionToken }) {
      const { session: value } = await session(sessionId, sessionToken);
      if (value.mode === VoiceMode.CALL) await within(value, async () => {});
      const configuration = clone(SpeechConfigurationSchema, (await settings()).configuration);
      if (configuration.transcription?.endpoint)
        configuration.transcription.endpoint.baseUrl = `${gatewayURL}/speech/transcription/v1`;
      if (configuration.synthesis?.endpoint)
        configuration.synthesis.endpoint.baseUrl = `${gatewayURL}/speech/synthesis`;
      return {
        mode: value.mode,
        languageCode: value.languageCode,
        speech: value.text ? { text: value.text, languageCode: value.languageCode } : undefined,
        configuration,
      };
    },
    async sendVoiceTurn({ sessionId, sessionToken, messageId, text }) {
      const ticket = await session(sessionId, sessionToken, VoiceMode.CALL);
      const value = ticket.session;
      return within(value, async () => {
        const sent = await messages.send(
          create(SendMessageRequestSchema, { agent, contextId: value.contextId, messageId, text }),
          create(UserIdentitySchema, { subject: value.subject }),
        );
        return { ...sent, sessionToken };
      });
    },
    async getVoiceAnswer({ sessionId, sessionToken, taskId }, context) {
      const { session: value } = await session(sessionId, sessionToken, VoiceMode.CALL);
      return within(value, async () => {
        const entry = await turn(value, taskId);
        const signal = AbortSignal.any([context.signal, AbortSignal.timeout(20_000)]);
        let touch = () => {};
        const streams = new TaskStreams(clients, signal, () => touch());
        let answer = create(GetVoiceAnswerResponseSchema);
        for await (answer of watch(
          projection,
          GetVoiceAnswerResponseSchema,
          signal,
          async () => {
            const current = (await projection.entry(taskId)) ?? entry;
            if (!terminal(current.state)) {
              streams.follow([current]);
              return create(GetVoiceAnswerResponseSchema);
            }
            const text = current.state === TaskState.COMPLETED ? speechText(current.answer) : "";
            return create(GetVoiceAnswerResponseSchema, {
              done: true,
              answer: text
                ? { text, languageCode: speechLanguage(text, await voices()) }
                : undefined,
            });
          },
          {
            wakes: (wake) => {
              touch = wake;
              return () => streams.close();
            },
          },
        ))
          if (answer.done) break;
        return answer;
      });
    },
    async cancelVoiceTurn({ sessionId, sessionToken, taskId }, context) {
      const { session: value } = await session(sessionId, sessionToken, VoiceMode.CALL);
      return within(value, async () => {
        const entry = await turn(value, taskId);
        await clients.a2a.cancelTask(
          { id: taskId, tenant: entry.agentId },
          { signal: context.signal, timeoutMs: 30_000 },
        );
        return {};
      });
    },
  };
}
