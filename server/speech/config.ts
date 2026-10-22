import { clone } from "@bufbuild/protobuf";
import { createValidator } from "@bufbuild/protovalidate";
import {
  type SpeechConfiguration,
  SpeechConfigurationSchema,
} from "../../gen/agentos/console/v1/speech_pb.js";

export function validateSpeechConfiguration(value: SpeechConfiguration) {
  const configuration = clone(SpeechConfigurationSchema, value);
  const result = createValidator().validate(SpeechConfigurationSchema, configuration);
  if (result.kind !== "valid") throw new Error(`Invalid speech configuration: ${result.error}`);
  for (const provider of [configuration.transcription, configuration.synthesis]) {
    if (!provider) continue;
    const url = new URL(provider.endpoint?.baseUrl ?? "");
    if (url.username || url.password || url.search || url.hash)
      throw new Error("Speech endpoint URLs must not contain credentials, queries or fragments");
  }
  const languages = new Set<string>();
  for (const voice of configuration.synthesis?.voices ?? []) {
    voice.languageCode = new Intl.Locale(voice.languageCode).language;
    if (languages.has(voice.languageCode)) throw new Error("Speech voice languages must be unique");
    languages.add(voice.languageCode);
  }
  return configuration;
}
