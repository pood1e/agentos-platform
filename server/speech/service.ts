import { readFileSync } from "node:fs";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type ServiceImpl } from "@connectrpc/connect";
import OpenAI, { toFile } from "openai";
import type { ConsoleService } from "../../gen/agentos/console/v1/console_service_pb.js";
import {
  type SpeechConfiguration,
  SpeechConfigurationSchema,
  type SpeechEndpoint,
  SpeechSynthesis_Protocol,
} from "../../gen/agentos/console/v1/speech_pb.js";
import { fail } from "../shared/errors.js";
import { selectVoice } from "./voices.js";

const formats = new Map([
  ["audio/webm", "webm"],
  ["audio/mp4", "mp4"],
  ["audio/ogg", "ogg"],
  ["audio/wav", "wav"],
  ["audio/mpeg", "mp3"],
]);
const maxSpeechBytes = 16 * 1024 * 1024;

function providerClient(provider?: SpeechEndpoint) {
  if (!provider) return undefined;
  return new OpenAI({
    baseURL: provider.baseUrl,
    apiKey: provider.apiKeyFile ? readFileSync(provider.apiKeyFile, "utf8").trim() : "not-required",
    maxRetries: 0,
    timeout: 60_000,
  });
}

async function* audioChunks(response: Response, signal: AbortSignal) {
  const reader = response.body?.getReader();
  if (!reader) throw fail(Code.Unavailable, "speech.unavailable");
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxSpeechBytes) throw fail(Code.ResourceExhausted, "speech.tooLarge");
      yield value;
    }
    if (!size) throw fail(Code.Unavailable, "speech.unavailable");
  } catch (error) {
    if (signal.aborted) throw new ConnectError("Speech request canceled", Code.Canceled);
    if (error instanceof ConnectError) throw error;
    throw fail(Code.Unavailable, "speech.unavailable");
  } finally {
    await reader.cancel();
  }
}

async function upstream<T>(
  signal: AbortSignal,
  invoke: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const deadline = AbortSignal.timeout(60_000);
  try {
    return await invoke(AbortSignal.any([signal, deadline]));
  } catch (error) {
    if (signal.aborted) throw new ConnectError("Speech request canceled", Code.Canceled);
    if (error instanceof ConnectError) throw error;
    if (error instanceof OpenAI.APIError && [400, 413, 415, 422].includes(error.status ?? 0))
      throw fail(Code.InvalidArgument, "speech.requestRejected");
    throw fail(Code.Unavailable, "speech.unavailable");
  }
}

export function speechService(
  configuration: SpeechConfiguration = create(SpeechConfigurationSchema),
) {
  const transcription = providerClient(configuration.transcription?.endpoint);
  const synthesis = providerClient(configuration.synthesis?.endpoint);
  return {
    getSpeechCapabilities: () => ({
      transcription: !!transcription,
      synthesis: !!synthesis,
      transcriptionLanguages: configuration.transcription?.languageCodes ?? [],
    }),
    async transcribeAudio(request, context) {
      if (!transcription || !configuration.transcription)
        throw fail(Code.FailedPrecondition, "speech.unavailable");
      const audio = request.audio;
      const contentType = audio?.contentType.split(";")[0].trim().toLowerCase() ?? "";
      const extension = formats.get(contentType);
      if (!audio || !extension) throw fail(Code.InvalidArgument, "speech.invalidAudio");
      return upstream(context.signal, async (signal) => {
        const file = await toFile(audio.data, `recording.${extension}`, { type: contentType });
        const result = await transcription.audio.transcriptions.create(
          { model: configuration.transcription?.model ?? "", file, response_format: "json" },
          { signal },
        );
        return { text: result.text };
      });
    },
    async *synthesizeSpeech(request, context) {
      const voice = selectVoice(request.text, configuration.synthesis?.voices ?? []);
      if (!synthesis || !voice) throw fail(Code.FailedPrecondition, "speech.unavailable");
      const nemo = configuration.synthesis?.protocol === SpeechSynthesis_Protocol.NEMO;
      const response = await upstream(context.signal, (signal) =>
        synthesis.audio.speech.create(
          {
            model: voice.model,
            voice: voice.voice,
            input: request.text,
            response_format: nemo ? "wav" : "mp3",
            ...(nemo
              ? { language: voice.languageCode === "ar" ? "ar-MSA" : voice.languageCode }
              : {}),
          },
          { signal },
        ),
      );
      let contentType =
        response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() ?? "audio/mpeg";
      if (contentType === "audio/mp3") contentType = "audio/mpeg";
      if (!contentType.startsWith("audio/")) {
        await response.body?.cancel();
        throw fail(Code.Unavailable, "speech.unavailable");
      }
      for await (const data of audioChunks(response, context.signal))
        yield { audio: { contentType, data } };
    },
  } satisfies Pick<
    ServiceImpl<typeof ConsoleService>,
    "getSpeechCapabilities" | "transcribeAudio" | "synthesizeSpeech"
  >;
}
