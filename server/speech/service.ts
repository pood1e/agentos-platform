import { readFileSync } from "node:fs";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type ServiceImpl } from "@connectrpc/connect";
import OpenAI, { toFile } from "openai";
import type { ConsoleService } from "../../gen/agentos/console/v1/console_service_pb.js";
import {
  type SpeechConfiguration,
  SpeechConfigurationSchema,
  type SpeechProvider,
} from "../../gen/agentos/console/v1/speech_pb.js";
import { fail } from "../shared/errors.js";

const formats = new Map([
  ["audio/webm", "webm"],
  ["audio/mp4", "mp4"],
  ["audio/ogg", "ogg"],
  ["audio/wav", "wav"],
  ["audio/mpeg", "mp3"],
]);
const maxSpeechBytes = 16 * 1024 * 1024;

function providerClient(provider?: SpeechProvider) {
  if (!provider) return undefined;
  return new OpenAI({
    baseURL: provider.baseUrl,
    apiKey: provider.apiKeyFile ? readFileSync(provider.apiKeyFile, "utf8").trim() : "not-required",
    maxRetries: 0,
    timeout: 60_000,
  });
}

async function audioData(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) throw fail(Code.Unavailable, "speech.unavailable");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxSpeechBytes) throw fail(Code.ResourceExhausted, "speech.tooLarge");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  if (!size) throw fail(Code.Unavailable, "speech.unavailable");
  const data = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return data;
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
  const transcription = providerClient(configuration.transcription);
  const synthesis = providerClient(configuration.synthesis);
  return {
    getSpeechCapabilities: () => ({ transcription: !!transcription, synthesis: !!synthesis }),
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
    async synthesizeSpeech(request, context) {
      if (!synthesis || !configuration.synthesis)
        throw fail(Code.FailedPrecondition, "speech.unavailable");
      return upstream(context.signal, async (signal) => {
        const response = await synthesis.audio.speech.create(
          {
            model: configuration.synthesis?.model ?? "",
            voice: configuration.voice,
            input: request.text,
            response_format: "wav",
          },
          { signal },
        );
        const contentType =
          response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() ?? "audio/wav";
        if (!contentType.startsWith("audio/")) {
          await response.body?.cancel();
          throw fail(Code.Unavailable, "speech.unavailable");
        }
        return { audio: { contentType, data: await audioData(response) } };
      });
    },
  } satisfies Pick<
    ServiceImpl<typeof ConsoleService>,
    "getSpeechCapabilities" | "transcribeAudio" | "synthesizeSpeech"
  >;
}
