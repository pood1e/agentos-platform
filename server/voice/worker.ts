import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type Interceptor, type ServiceImpl } from "@connectrpc/connect";
import { TaskState } from "../../gen/a2a_pb.js";
import { SendMessageRequestSchema } from "../../gen/agentos/console/v1/console_service_pb.js";
import { VoiceMode } from "../../gen/agentos/console/v1/speech_pb.js";
import type { ExecutionIdentity } from "../../gen/agentos/execution/v1/identity_pb.js";
import {
  GetVoiceAnswerResponseSchema,
  type VoiceService,
} from "../../gen/agentos/voice/v1/voice_pb.js";
import { speechText } from "../../shared/speech-text.js";
import type { Executions } from "../authorization/executions.js";
import type { serviceAccountTokens } from "../authorization/workloads.js";
import { cancellationCommands } from "../console/cancellation.js";
import { messageCommands } from "../console/messages.js";
import { watch } from "../console/watch.js";
import type { KagentClients } from "../kagent/clients.js";
import type { TaskProjection } from "../read-model/projection.js";
import { refreshContexts } from "../read-model/reconcile.js";
import { terminal } from "../read-model/state.js";
import { TaskStreams } from "../read-model/streams.js";
import { speechLanguage } from "./language.js";
import type { VoiceSession, VoiceSessions } from "./sessions.js";
import type { SpeechSource } from "./settings.js";

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
  sessions: VoiceSessions;
  projection: TaskProjection;
  clients: KagentClients;
  executions: Executions;
  /** The initiator's current identity, renewed through its offline grant. */
  initiator: (subject: string) => Promise<ExecutionIdentity | undefined>;
  /** Calls talk to the entry agent. */
  agent: { namespace: string; name: string };
}

export function voiceService({
  settings,
  sessions,
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

  async function session(id: string, mode?: VoiceMode) {
    const value = await sessions.get(id);
    if (!value || (mode !== undefined && value.mode !== mode)) throw denied();
    return value;
  }
  async function caller(value: VoiceSession) {
    const identity = await initiator(value.subject);
    if (!identity) throw denied();
    return identity;
  }
  // Turns are tasks of the session's own conversation.
  async function turn(value: VoiceSession, taskId: string) {
    const entry = await projection.entry(taskId);
    if (!entry || !value.contextId || entry.contextId !== value.contextId) throw denied();
    return entry;
  }

  return {
    async getVoiceSession({ sessionId }) {
      const value = await session(sessionId);
      const { configuration, transcriptionCredential, synthesisCredential } = await settings();
      return {
        mode: value.mode,
        languageCode: value.languageCode,
        speech: value.text ? { text: value.text, languageCode: value.languageCode } : undefined,
        configuration,
        transcriptionCredential,
        synthesisCredential,
      };
    },
    async sendVoiceTurn({ sessionId, messageId, text }) {
      const value = await session(sessionId, VoiceMode.CALL);
      const sent = await messages.send(
        create(SendMessageRequestSchema, { agent, contextId: value.contextId, messageId, text }),
        await caller(value),
      );
      if (!value.contextId && !(await sessions.bind(sessionId, sent.contextId))) throw denied();
      return sent;
    },
    async getVoiceAnswer({ sessionId, taskId }, context) {
      const value = await session(sessionId, VoiceMode.CALL);
      const entry = await turn(value, taskId);
      const root = (await projection.session(value.contextId))?.root;
      const signal = AbortSignal.any([context.signal, AbortSignal.timeout(20_000)]);
      let touch = () => {};
      const streams = new TaskStreams(clients, signal, () => touch());
      let answer = create(GetVoiceAnswerResponseSchema);
      for await (answer of watch(
        projection,
        GetVoiceAnswerResponseSchema,
        signal,
        async () => {
          let current = (await projection.entry(taskId)) ?? entry;
          // A settled turn reaches the projection before the next turn checks the conversation;
          // a failed refresh leaves it to the reconciler.
          if (!terminal(current.state) && terminal(streams.task(taskId)?.status?.state)) {
            const { contextId: id, agentId } = current;
            await refreshContexts(projection, clients, [{ id, agentId }], signal).catch(() => {});
            current = (await projection.entry(taskId)) ?? current;
          }
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
          roots: () => (root ? new Set([root]) : undefined),
          wakes: (wake) => {
            touch = wake;
            return () => streams.close();
          },
        },
      ))
        if (answer.done) break;
      return answer;
    },
    async cancelVoiceTurn({ sessionId, taskId }, context) {
      const value = await session(sessionId, VoiceMode.CALL);
      await turn(value, taskId);
      await cancel(taskId, await caller(value), context.signal);
      return {};
    },
  };
}
