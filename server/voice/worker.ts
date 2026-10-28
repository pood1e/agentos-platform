import { clone, create } from "@bufbuild/protobuf";
import { Code, ConnectError, type Interceptor, type ServiceImpl } from "@connectrpc/connect";
import { TaskState } from "../../gen/a2a_pb.js";
import { SendMessageRequestSchema } from "../../gen/agentos/console/v1/console_service_pb.js";
import { SpeechConfigurationSchema, VoiceMode } from "../../gen/agentos/console/v1/speech_pb.js";
import type { ExecutionIdentity } from "../../gen/agentos/execution/v1/identity_pb.js";
import {
  GetVoiceAnswerResponseSchema,
  type VoiceService,
  type VoiceSession,
} from "../../gen/agentos/voice/v1/voice_pb.js";
import { speechText } from "../../shared/speech-text.js";
import { shortTitle } from "../../shared/title.js";
import type { Executions } from "../authorization/executions.js";
import type { serviceAccountTokens } from "../authorization/workloads.js";
import { cancellationCommands } from "../console/cancellation.js";
import { messageCommands } from "../console/messages.js";
import { watch } from "../console/watch.js";
import type { KagentClients } from "../kagent/clients.js";
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
  executions: Executions;
  /** The initiator's current identity, renewed through its offline grant. */
  initiator: (subject: string) => Promise<ExecutionIdentity | undefined>;
  /** Calls talk to the entry agent. */
  agent: { namespace: string; name: string };
}

export function voiceService({
  settings,
  gatewayURL,
  tickets,
  projection,
  clients,
  executions,
  initiator,
  agent,
}: VoiceWorkerDependencies): ServiceImpl<typeof VoiceService> {
  const messages = messageCommands(projection, clients, agent.namespace, executions);
  const cancel = cancellationCommands(projection, clients, executions);
  const voices = async () =>
    (await settings()).configuration.synthesis?.voices.map((voice) => voice.languageCode) ?? [];

  async function session(id: string, token: string, mode?: VoiceMode) {
    const ticket = await tickets.verify(id, token);
    if (mode !== undefined && ticket.session.mode !== mode) throw denied();
    return ticket;
  }
  async function caller(value: VoiceSession) {
    const identity = await initiator(value.subject);
    if (!identity || identity.subject !== value.subject) throw denied();
    if (value.contextId) {
      const { session: native } = await clients.sessions.getSession({ sessionId: value.contextId });
      if (!native) throw denied();
      await executions.own(native, identity);
    }
    return identity;
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
      if (value.mode === VoiceMode.CALL) await caller(value);
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
      const identity = await caller(value);
      let contextId = value.contextId;
      if (!contextId) {
        if (messageId !== value.id) throw denied();
        const { session: native } = await clients.sessions.createSession(
          { agent, requestId: value.id, name: shortTitle(text) },
          { timeoutMs: 30_000 },
        );
        if (!native) throw denied();
        await executions.bind(native, identity);
        contextId = native.id;
      }
      const sent = await messages.send(
        create(SendMessageRequestSchema, { agent, contextId, messageId, text }),
        identity,
      );
      return { ...sent, sessionToken: await tickets.bind(ticket, sent.contextId) };
    },
    async getVoiceAnswer({ sessionId, sessionToken, taskId }, context) {
      const { session: value } = await session(sessionId, sessionToken, VoiceMode.CALL);
      await caller(value);
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
            answer: text ? { text, languageCode: speechLanguage(text, await voices()) } : undefined,
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
    },
    async cancelVoiceTurn({ sessionId, sessionToken, taskId }, context) {
      const { session: value } = await session(sessionId, sessionToken, VoiceMode.CALL);
      await turn(value, taskId);
      await cancel(taskId, await caller(value), context.signal);
      return {};
    },
  };
}
