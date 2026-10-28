import { create, fromJsonString } from "@bufbuild/protobuf";
import { expect, it } from "vitest";
import { SpeechConfigurationSchema } from "../gen/agentos/console/v1/speech_pb.js";
import { validateSpeechConfiguration } from "../server/voice/config.js";

function configuration(value: unknown) {
  return () =>
    validateSpeechConfiguration(fromJsonString(SpeechConfigurationSchema, JSON.stringify(value)));
}

it("defaults to no speech capabilities", () => {
  expect(
    validateSpeechConfiguration(create(SpeechConfigurationSchema)).transcription,
  ).toBeUndefined();
  expect(validateSpeechConfiguration(create(SpeechConfigurationSchema)).synthesis).toBeUndefined();
});

it("loads independent provider settings without requiring OIDC", () => {
  expect(
    configuration({
      transcription: { endpoint: { baseUrl: "http://speech.example.test/v1" }, model: "asr" },
    })(),
  ).toMatchObject({ transcription: { model: "asr" } });
  expect(
    configuration({
      synthesis: {
        endpoint: { baseUrl: "https://speech.example.test/v1" },
        voices: [{ languageCode: "cmn", model: "tts", voice: "default" }],
      },
    })(),
  ).toMatchObject({
    synthesis: { voices: [{ languageCode: "zh", model: "tts", voice: "default" }] },
  });
});

it.each([
  { transcription: {} },
  { transcription: { endpoint: { baseUrl: "file:///tmp/speech" }, model: "asr" } },
  {
    transcription: {
      endpoint: { baseUrl: "https://user:password@speech.example.test/v1" },
      model: "asr",
    },
  },
  {
    transcription: {
      endpoint: { baseUrl: "https://speech.example.test/v1?token=secret" },
      model: "asr",
    },
  },
  { synthesis: { endpoint: { baseUrl: "https://speech.example.test/v1" }, voices: [] } },
  {
    transcription: {
      endpoint: { baseUrl: "https://speech.example.test/v1", apiKey: "secret" },
      model: "asr",
    },
  },
  { transcription: { baseUrl: "https://speech.example.test/v1", model: "asr" } },
  { voice: "removed" },
  {
    transcription: {
      endpoint: { baseUrl: "https://speech.example.test/v1", apiKeyFile: "/run/key" },
      model: "asr",
    },
  },
  {
    synthesis: {
      endpoint: { baseUrl: "https://speech.example.test/v1" },
      voices: [
        { languageCode: "zh", model: "one", voice: "one" },
        { languageCode: "cmn", model: "two", voice: "two" },
      ],
    },
  },
])("rejects incomplete or unsupported provider configuration", (value) => {
  expect(configuration(value)).toThrow();
});
