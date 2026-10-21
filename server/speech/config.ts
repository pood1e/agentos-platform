import { readFileSync } from "node:fs";
import { create, fromJsonString } from "@bufbuild/protobuf";
import { createValidator } from "@bufbuild/protovalidate";
import { SpeechConfigurationSchema } from "../../gen/agentos/console/v1/speech_pb.js";

export function speechConfig(env = process.env) {
  if (!env.AGENTOS_SPEECH_CONFIG) return create(SpeechConfigurationSchema);
  const configuration = fromJsonString(
    SpeechConfigurationSchema,
    readFileSync(env.AGENTOS_SPEECH_CONFIG, "utf8"),
  );
  const result = createValidator().validate(SpeechConfigurationSchema, configuration);
  if (result.kind !== "valid") throw new Error(`Invalid speech configuration: ${result.error}`);
  for (const provider of [configuration.transcription, configuration.synthesis]) {
    if (!provider) continue;
    const url = new URL(provider.baseUrl);
    if (url.username || url.password || url.search || url.hash)
      throw new Error("Speech endpoint URLs must not contain credentials, queries or fragments");
  }
  return configuration;
}
