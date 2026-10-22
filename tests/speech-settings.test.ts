import { create, fromJsonString } from "@bufbuild/protobuf";
import { Code, createClient, createRouterTransport } from "@connectrpc/connect";
import { afterEach, beforeEach, expect, it } from "vitest";
import { SpeechConfigurationSchema } from "../gen/agentos/console/v1/speech_pb.js";
import { ManagementService } from "../gen/agentos/management/v1/management_pb.js";
import { object } from "../server/read-model/decode/messages.js";
import { speechService } from "../server/speech/service.js";
import { managementEnvironment } from "./management-harness.js";

let env: Awaited<ReturnType<typeof managementEnvironment>>;
let client: ReturnType<typeof createClient<typeof ManagementService>>;
beforeEach(async () => {
  env = await managementEnvironment();
  client = createClient(
    ManagementService,
    createRouterTransport((router) => router.service(ManagementService, env.service)),
  );
});
afterEach(async () => env.close());

const configuration = () =>
  create(SpeechConfigurationSchema, {
    transcription: {
      endpoint: { baseUrl: "https://asr.example/v1" },
      model: "asr",
      languageCodes: ["zh", "en", "ar"],
    },
    synthesis: {
      endpoint: { baseUrl: "https://tts.example/v1" },
      voices: [{ languageCode: "zh", model: "tts", voice: "default" }],
    },
  });

it("atomically saves speech settings and write-only credentials and immediately refreshes active clients", async () => {
  const initial = await client.getSpeechConfiguration({});
  expect((await env.dependencies.speech.load()).configuration.transcription).toBeUndefined();
  const { settings } = await client.saveSpeechConfiguration({
    configuration: configuration(),
    resourceVersion: initial.resourceVersion,
    transcriptionCredential: "private-asr-key",
    synthesisCredential: "private-tts-key",
  });
  expect(settings).toMatchObject({
    transcriptionCredentialConfigured: true,
    synthesisCredentialConfigured: true,
  });
  expect(JSON.stringify(settings)).not.toContain("private-");
  expect(await client.getSpeechConfiguration({})).toEqual(settings);
  const current = await env.dependencies.speech.load();
  expect(current).toMatchObject({
    transcriptionCredential: "private-asr-key",
    synthesisCredential: "private-tts-key",
  });
  const service = speechService(env.dependencies.speech.load);
  expect(await service.getSpeechCapabilities()).toMatchObject({
    transcription: true,
    synthesis: true,
    transcriptionLanguages: ["zh", "en", "ar"],
  });
  await client.saveSpeechConfiguration({
    configuration: create(SpeechConfigurationSchema),
    resourceVersion: settings?.resourceVersion,
  });
  expect(await service.getSpeechCapabilities()).toMatchObject({
    transcription: false,
    synthesis: false,
  });
});

it("rejects stale writes without changing provider settings or credentials", async () => {
  const initial = await client.getSpeechConfiguration({});
  const saved = await client.saveSpeechConfiguration({
    configuration: configuration(),
    resourceVersion: initial.resourceVersion,
    transcriptionCredential: "original-key",
  });
  await expect(
    client.saveSpeechConfiguration({
      configuration: create(SpeechConfigurationSchema),
      resourceVersion: initial.resourceVersion,
      transcriptionCredential: "stale-key",
    }),
  ).rejects.toMatchObject({ code: Code.Aborted });
  expect(await client.getSpeechConfiguration({})).toEqual(saved.settings);
  expect((await env.dependencies.speech.load()).transcriptionCredential).toBe("original-key");
});

it("preserves referenced credentials on edit and explicitly clears only the selected provider", async () => {
  env.fake.resources.save(
    "secrets",
    {
      apiVersion: "v1",
      kind: "Secret",
      metadata: { name: "speech-credentials" },
      data: {
        "transcription-api-key": Buffer.from("external-asr").toString("base64"),
        "synthesis-api-key": Buffer.from("external-tts").toString("base64"),
      },
    },
    true,
  );
  const existing = env.fake.resources.get("secrets", "agentos-speech");
  existing.data = {
    ...object(existing.data),
    "credentials-secret": Buffer.from("speech-credentials").toString("base64"),
  };
  env.fake.resources.save("secrets", existing, false);
  const first = await client.getSpeechConfiguration({});
  const { settings } = await client.saveSpeechConfiguration({
    configuration: configuration(),
    resourceVersion: first.resourceVersion,
  });
  expect(settings).toMatchObject({
    transcriptionCredentialConfigured: true,
    synthesisCredentialConfigured: true,
  });
  const cleared = await client.saveSpeechConfiguration({
    configuration: configuration(),
    resourceVersion: settings?.resourceVersion,
    transcriptionCredential: "",
  });
  expect(cleared.settings).toMatchObject({
    transcriptionCredentialConfigured: false,
    synthesisCredentialConfigured: true,
  });
  expect(await env.dependencies.speech.load()).toMatchObject({
    transcriptionCredential: "",
    synthesisCredential: "external-tts",
  });
});

it("rejects invalid provider configuration before mutating the versioned secret", async () => {
  const initial = await client.getSpeechConfiguration({});
  const invalid = configuration();
  if (invalid.transcription?.endpoint)
    invalid.transcription.endpoint.baseUrl = "https://user:password@asr.example/v1";
  await expect(
    client.saveSpeechConfiguration({
      configuration: invalid,
      resourceVersion: initial.resourceVersion,
      transcriptionCredential: "invalid-key",
    }),
  ).rejects.toMatchObject({ code: Code.InvalidArgument });
  expect(await client.getSpeechConfiguration({})).toEqual(initial);
  const secret = env.fake.resources.get("secrets", "agentos-speech");
  expect(
    fromJsonString(
      SpeechConfigurationSchema,
      Buffer.from(String(object(secret.data)["configuration.json"]), "base64").toString(),
    ),
  ).toEqual(initial.configuration);
});
