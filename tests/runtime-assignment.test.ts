import type { JsonObject } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient, createRouterTransport } from "@connectrpc/connect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ManagementService } from "../gen/agentos/management/v1/management_pb.js";
import { object, text } from "../server/read-model/decode/messages.js";
import { managementEnvironment } from "./management-harness.js";

let env: Awaited<ReturnType<typeof managementEnvironment>>;
let client: ReturnType<typeof createClient<typeof ManagementService>>;
const ref = (name: string) => ({ name, namespace: "agentos" });
beforeEach(async () => {
  env = await managementEnvironment();
  client = createClient(
    ManagementService,
    createRouterTransport((router) => router.service(ManagementService, env.service)),
  );
  for (const [name, provider, protocol] of [
    [
      "responses-model",
      "OpenAI",
      { openAI: { baseUrl: env.dependencies.gateway.url, apiFormat: "responses" } },
    ],
    [
      "messages-model",
      "Anthropic",
      {
        anthropic: { baseUrl: env.dependencies.gateway.url, cacheTTL: "5m", promptCaching: false },
      },
    ],
  ] as const)
    await env.store.save(
      "modelConfigs",
      {
        apiVersion: "api.kagent.dev/v1alpha3",
        kind: "ModelConfig",
        metadata: { name },
        spec: {
          provider,
          model: "test-model",
          apiKeySecret: "test",
          apiKeySecretKey: "api-key",
          ...protocol,
        },
      },
      true,
    );
});
afterEach(async () => env.close());

async function request(harness: string, model: string) {
  const { agent, agentTemplate } = await client.getEngineerRuntime({ ref: ref("diagnosis") });
  return {
    engineer: ref("diagnosis"),
    harness: ref(harness),
    modelConfig: ref(model),
    generation: BigInt(String(object(agent?.resource?.value?.metadata).generation)),
    expectedUid: text(object(agent?.resource?.value?.metadata).uid),
    templateResourceVersion: agentTemplate
      ? text(object(agentTemplate.resource?.value?.metadata).resourceVersion)
      : undefined,
  };
}

describe("joint Harness and model configuration", () => {
  it("switches between Claude and Codex in both directions without rewriting prompts or existing sessions", async () => {
    const prompt = object(env.fake.template("diagnosis").resource?.value?.spec).systemPrompt;
    const sessions = structuredClone([...env.fake.sessions.values()]);
    for (const [harness, model] of [
      ["claude", "messages-model"],
      ["codex", "responses-model"],
      ["claude", "messages-model"],
    ]) {
      const result = await client.setEngineerRuntime(await request(harness, model));
      expect(object(result.agent?.resource?.value?.spec).harnessRef).toEqual({ name: harness });
      expect(object(result.agentTemplate?.resource?.value?.spec)).toMatchObject({
        modelConfig: { name: model },
        systemPrompt: prompt,
      });
    }
    expect([...env.fake.sessions.values()]).toEqual(sessions);
  });

  it("rejects a stale template or cross-workspace model before writing either resource", async () => {
    const edit = await request("claude", "messages-model");
    const template = env.fake.template("diagnosis");
    const changed = structuredClone(template);
    object(changed.resource?.value?.spec).systemPrompt = "Concurrent prompt edit";
    env.fake.replaceTemplate(changed);
    await expect(client.setEngineerRuntime(edit)).rejects.toMatchObject({ code: Code.Aborted });
    await expect(
      client.setEngineerRuntime({
        ...(await request("claude", "messages-model")),
        modelConfig: { name: "messages-model", namespace: "other" },
      }),
    ).rejects.toMatchObject({ code: Code.InvalidArgument });
    expect(object(env.fake.template("diagnosis").resource?.value?.spec)).toMatchObject({
      modelConfig: { name: "default-model-config" },
      systemPrompt: "Concurrent prompt edit",
    });
    expect(object((await env.store.get("agents", "diagnosis")).spec).harnessRef).toEqual({
      name: "standard",
    });
  });

  it("restores the previous model if saving the engineer fails", async () => {
    const original = structuredClone(object(env.fake.template("diagnosis").resource?.value?.spec));
    const save = env.store.save.bind(env.store);
    vi.spyOn(env.store, "save").mockImplementation(async (kind, value, create) => {
      if (kind === "agents") throw new ConnectError("API unavailable", Code.Unavailable);
      return save(kind, value, create);
    });
    await expect(
      client.setEngineerRuntime(await request("claude", "messages-model")),
    ).rejects.toMatchObject({ code: Code.Unavailable });
    expect(object(env.fake.template("diagnosis").resource?.value?.spec)).toEqual(original);
    expect(object((await env.store.get("agents", "diagnosis")).spec).harnessRef).toEqual({
      name: "standard",
    });
  });

  it("preserves a concurrent template edit when compensation can no longer restore its own version", async () => {
    const save = env.store.save.bind(env.store);
    vi.spyOn(env.store, "save").mockImplementation(async (kind, value, create) => {
      if (kind === "agents") {
        const concurrent = structuredClone(env.fake.template("diagnosis"));
        object(concurrent.resource?.value?.spec).systemPrompt = "Concurrent prompt edit";
        env.fake.replaceTemplate(concurrent);
        throw new ConnectError("API unavailable", Code.Unavailable);
      }
      return save(kind, value, create);
    });
    await expect(
      client.setEngineerRuntime(await request("claude", "messages-model")),
    ).rejects.toThrow("harness.partialSave");
    expect(object(env.fake.template("diagnosis").resource?.value?.spec)).toMatchObject({
      modelConfig: { name: "messages-model" },
      systemPrompt: "Concurrent prompt edit",
    });
  });

  it("keeps other engineers sharing the role compatible with the selected model", async () => {
    await client.setEngineerRuntime(await request("claude", "messages-model"));
    const original = await env.store.get("agents", "diagnosis");
    await env.store.save(
      "agents",
      {
        ...original,
        metadata: { name: "diagnosis-two" },
      },
      true,
    );
    await expect(
      client.setEngineerRuntime(await request("codex", "responses-model")),
    ).rejects.toThrow("harness.sharedModel");
    expect(object(env.fake.template("diagnosis").resource?.value?.spec).modelConfig).toEqual({
      name: "messages-model",
    });
  });

  it("updates an inline native template and Harness in a single engineer write", async () => {
    const original = await env.store.get("agents", "diagnosis");
    const spec: JsonObject = {
      ...object(original.spec),
      template: object(env.fake.template("diagnosis").resource?.value?.spec),
    };
    delete spec.templateRef;
    await env.store.save("agents", { ...original, spec }, false);
    const save = vi.spyOn(env.store, "save");
    const result = await client.setEngineerRuntime(await request("claude", "messages-model"));
    expect(object(result.agent?.resource?.value?.spec)).toMatchObject({
      template: { modelConfig: { name: "messages-model" } },
      harnessRef: { name: "claude" },
    });
    expect(result.agentTemplate).toBeUndefined();
    expect(save).toHaveBeenCalledTimes(1);
  });
});
