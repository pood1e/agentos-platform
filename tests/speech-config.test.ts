import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { speechConfig } from "../server/speech/config.js";

function configuration(value: unknown) {
  const directory = mkdtempSync(join(tmpdir(), "agentos-speech-"));
  onTestFinished(() => rmSync(directory, { recursive: true }));
  const file = join(directory, "speech.json");
  writeFileSync(file, JSON.stringify(value));
  return () => speechConfig({ AGENTOS_SPEECH_CONFIG: file });
}

it("defaults to no speech capabilities", () => {
  expect(speechConfig({}).transcription).toBeUndefined();
  expect(speechConfig({}).synthesis).toBeUndefined();
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
        endpoint: { baseUrl: "https://speech.example.test/v1", apiKeyFile: "/run/credentials/tts" },
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
