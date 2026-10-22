import { createHash } from "node:crypto";
import { create, fromJsonString, toJsonString } from "@bufbuild/protobuf";
import { Code, ConnectError, type HandlerContext } from "@connectrpc/connect";
import { VoiceCallConnectionSchema } from "../../gen/agentos/console/v1/speech_pb.js";
import {
  EndSessionRequestSchema,
  StartSessionRequestSchema,
} from "../../gen/agentos/voice/v1/worker_pb.js";
import { accessProfile, requestIdentity } from "../platform/access.js";
import { fail } from "../shared/errors.js";
import type { SpeechSource } from "./store.js";

export function voiceCalls(source: SpeechSource, url = "", token = "") {
  const owner = (context: HandlerContext) =>
    createHash("sha256")
      .update(
        JSON.stringify([
          context.values.get(accessProfile).workspace,
          context.values.get(requestIdentity).subject,
        ]),
      )
      .digest("hex");
  async function request(path: string, signal: AbortSignal, body?: string) {
    if (!url || !token) throw fail(Code.FailedPrecondition, "speech.unavailable");
    try {
      const response = await fetch(new URL(path, url), {
        method: body ? "POST" : "GET",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body,
        signal: AbortSignal.any([signal, AbortSignal.timeout(body ? 15_000 : 2000)]),
      });
      if (response.status === 403)
        throw new ConnectError("Permission denied", Code.PermissionDenied);
      if (response.status === 429) throw fail(Code.ResourceExhausted, "speech.unavailable");
      if (!response.ok) throw fail(Code.Unavailable, "speech.unavailable");
      return response;
    } catch (error) {
      if (signal.aborted) throw new ConnectError("Voice request canceled", Code.Canceled);
      if (error instanceof ConnectError) throw error;
      throw fail(Code.Unavailable, "speech.unavailable");
    }
  }
  return {
    async available() {
      if (!url || !token) return false;
      try {
        await request("/readyz", new AbortController().signal);
        return true;
      } catch {
        return false;
      }
    },
    async start(callId: string, languageCode: string, context: HandlerContext) {
      const settings = await source();
      const { transcription, synthesis } = settings.configuration;
      if (!transcription?.endpoint || !synthesis?.endpoint)
        throw fail(Code.FailedPrecondition, "speech.unavailable");
      if (languageCode && !transcription.languageCodes.includes(languageCode))
        throw fail(Code.InvalidArgument, "speech.requestRejected");
      const response = await request(
        "/calls/start",
        context.signal,
        toJsonString(
          StartSessionRequestSchema,
          create(StartSessionRequestSchema, {
            callId,
            owner: owner(context),
            languageCode,
            speech: settings.configuration,
            transcriptionCredential: settings.transcriptionCredential,
            synthesisCredential: settings.synthesisCredential,
          }),
        ),
      );
      const connection = fromJsonString(VoiceCallConnectionSchema, await response.text());
      if (connection.callId !== callId || !connection.token || !/^wss?:\/\//u.test(connection.url))
        throw fail(Code.Unavailable, "speech.unavailable");
      return { connection };
    },
    async end(callId: string, context: HandlerContext) {
      await request(
        "/calls/end",
        context.signal,
        toJsonString(
          EndSessionRequestSchema,
          create(EndSessionRequestSchema, {
            callId,
            owner: owner(context),
          }),
        ),
      );
      return {};
    },
  };
}
