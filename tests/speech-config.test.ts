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
      transcription: { baseUrl: "http://speech.example.test/v1", model: "asr" },
    })(),
  ).toMatchObject({ transcription: { model: "asr" } });
  expect(
    configuration({
      synthesis: {
        baseUrl: "https://speech.example.test/v1",
        model: "tts",
        apiKeyFile: "/run/credentials/tts",
      },
      voice: "multilingual",
    })(),
  ).toMatchObject({ synthesis: { model: "tts" }, voice: "multilingual" });
});

it.each([
  { transcription: {} },
  { transcription: { baseUrl: "file:///tmp/speech", model: "asr" } },
  { transcription: { baseUrl: "https://user:password@speech.example.test/v1", model: "asr" } },
  { transcription: { baseUrl: "https://speech.example.test/v1?token=secret", model: "asr" } },
  { synthesis: { baseUrl: "https://speech.example.test/v1", model: "tts" } },
  { transcription: { baseUrl: "https://speech.example.test/v1", model: "asr", apiKey: "secret" } },
])("rejects incomplete or unsupported provider configuration", (value) => {
  expect(configuration(value)).toThrow();
});
