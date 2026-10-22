import { create, type JsonObject } from "@bufbuild/protobuf";
import { Code, createClient, createRouterTransport } from "@connectrpc/connect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ManagementService } from "../gen/agentos/management/v1/management_pb.js";
import { HarnessSchema } from "../gen/kagent/api/v1/harnesses_pb.js";
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
});
afterEach(async () => env.close());

async function assign(engineer: string, harness: string, model?: string) {
  const { agent, agentTemplate } = await client.getEngineerRuntime({ ref: ref(engineer) });
  return client.setEngineerRuntime({
    engineer: ref(engineer),
    harness: ref(harness),
    generation: BigInt(String(object(agent?.resource?.value?.metadata).generation)),
    expectedUid: text(object(agent?.resource?.value?.metadata).uid),
    modelConfig: ref(
      model ?? text(object(object(agentTemplate?.resource?.value?.spec).modelConfig).name),
    ),
    templateResourceVersion: text(object(agentTemplate?.resource?.value?.metadata).resourceVersion),
  });
}

describe("native Harness configuration", () => {
  it("changes one engineer while preserving its shared template and existing sessions", async () => {
    const original = await env.store.get("agents", "inspection");
    const secondMetadata: JsonObject = { ...object(original.metadata), name: "inspection-two" };
    delete secondMetadata.resourceVersion;
    env.fake.resources.save(
      "agents",
      {
        ...original,
        metadata: secondMetadata,
      },
      true,
    );
    const template = structuredClone(env.fake.template("inspection"));
    const sessions = structuredClone([...env.fake.sessions.values()]);
    const { agent } = await assign("inspection", "codex");
    expect(object(agent?.resource?.value?.spec)).toMatchObject({
      template: { ref: { name: "inspection" } },
      harnessRef: { name: "codex" },
    });
    expect(object((await env.store.get("agents", "inspection-two")).spec).harnessRef).toEqual({
      name: "standard",
    });
    expect(env.fake.template("inspection")).toEqual(template);
    expect([...env.fake.sessions.values()]).toEqual(sessions);
  });

  it("rejects stale and cross-workspace assignments without overwriting the engineer", async () => {
    const original = await env.store.get("agents", "inspection");
    const request = {
      engineer: ref("inspection"),
      harness: ref("codex"),
      generation: BigInt(String(object(original.metadata).generation)),
      expectedUid: text(object(original.metadata).uid),
      modelConfig: ref("default-model-config"),
      templateResourceVersion: text(
        object(env.fake.template("inspection").resource?.value?.metadata).resourceVersion,
      ),
    };
    await client.setEngineerRuntime(request);
    await expect(
      client.setEngineerRuntime({ ...request, harness: ref("standard") }),
    ).rejects.toMatchObject({ code: Code.Aborted });
    await expect(
      client.setEngineerRuntime({
        ...request,
        engineer: { ...ref("inspection"), namespace: "other" },
      }),
    ).rejects.toMatchObject({ code: Code.InvalidArgument });
    await expect(
      client.setEngineerRuntime({
        ...request,
        harness: { ...ref("codex"), namespace: "other" },
        generation: BigInt(
          String(object((await env.store.get("agents", "inspection")).metadata).generation),
        ),
      }),
    ).rejects.toMatchObject({ code: Code.InvalidArgument });
    expect(object((await env.store.get("agents", "inspection")).spec).harnessRef).toEqual({
      name: "codex",
    });
  });

  it("protects Codex model options and preserves Claude MCP tool subsets", async () => {
    const model = await env.store.get("modelConfigs", "default-model-config");
    const spec = object(model.spec);
    await env.store.save(
      "modelConfigs",
      {
        ...model,
        spec: { ...spec, openAI: { ...object(spec.openAI), maxCompletionTokens: 8192 } },
      },
      false,
    );
    await expect(assign("inspection", "codex")).rejects.toThrow("harness.modelOptions");
    const latest = await env.store.get("modelConfigs", "default-model-config");
    await env.store.save(
      "modelConfigs",
      {
        ...latest,
        spec: {
          provider: "Anthropic",
          model: "claude-test",
          apiKeySecret: "agentos-gateway",
          apiKeySecretKey: "api-key",
          anthropic: { baseUrl: env.dependencies.gateway.url, cacheTTL: "5m" },
        },
      },
      false,
    );
    const selectedTools = structuredClone(
      object(env.fake.template("inspection").resource?.value?.spec).tools,
    );
    await assign("inspection", "claude");
    expect(object(env.fake.template("inspection").resource?.value?.spec).tools).toEqual(
      selectedTools,
    );
    expect(object((await env.store.get("agents", "inspection")).spec).harnessRef).toEqual({
      name: "claude",
    });
    const template = env.fake.template("inspection");
    if (!template.resource?.value) throw new Error("template missing");
    const all =
      env.fake.toolServers.find((item) => item.ref.endsWith("/kagent-tool-server"))
        ?.discoveredTools ?? [];
    object(template.resource.value.spec).tools = [
      {
        mcp: {
          server: { name: "kagent-tool-server", kind: "RemoteMCPServer" },
          tools: all.map((item) => item.name),
        },
      },
    ];
    await assign("inspection", "claude");
    expect(object((await env.store.get("agents", "inspection")).spec).harnessRef).toEqual({
      name: "claude",
    });
  });

  it("manages arbitrary BYO Harnesses and refuses deletion while assigned", async () => {
    const harness = create(HarnessSchema, {
      ref: ref("custom-operations"),
      resource: {
        apiVersion: "api.kagent.dev/v1alpha3",
        kind: "Harness",
        value: {
          apiVersion: "api.kagent.dev/v1alpha3",
          kind: "Harness",
          metadata: { name: "custom-operations" },
          spec: {
            byo: {},
            workload: {
              image: `registry.example/operations@sha256:${"a".repeat(64)}`,
              command: ["/operations"],
            },
            substrate: {
              workerPoolRef: { name: "kagent-default" },
              snapshotPolicy: { location: "s3://snapshots/operations/" },
            },
          },
        },
      },
    });
    const { harness: saved } = await client.saveHarness({ harness, create: true });
    expect(
      (await client.listHarnesses({})).harnesses.find(
        (item) => item.ref?.name === "custom-operations",
      )?.runtime,
    ).toBe("byo");
    await assign("inspection", "custom-operations");
    const remove = {
      ref: saved?.ref,
      resourceVersion: text(object(saved?.resource?.value?.metadata).resourceVersion),
    };
    await expect(client.deleteHarness(remove)).rejects.toThrow("harness.inUse");
    const updated = await client.saveHarness({ harness: saved });
    await expect(client.saveHarness({ harness: saved })).rejects.toMatchObject({
      code: Code.Aborted,
    });
    await assign("inspection", "standard");
    await client.deleteHarness({
      ...remove,
      resourceVersion: text(object(updated.harness?.resource?.value?.metadata).resourceVersion),
    });
    expect(
      (await client.listHarnesses({})).harnesses.some(
        (item) => item.ref?.name === "custom-operations",
      ),
    ).toBe(false);
  });

  it("allows native approval-gated tools on Codex without custom credential forwarding", async () => {
    const template = env.fake.template("inspection");
    if (!template.resource?.value) throw new Error("template missing");
    object(template.resource.value.spec).tools = [
      {
        mcp: {
          server: { name: "kagent-tool-server", kind: "RemoteMCPServer" },
          tools: ["k8s_get_resources"],
          requireApproval: true,
        },
      },
    ];
    const before = await env.store.get("agents", "inspection");
    await assign("inspection", "codex");
    expect(object((await env.store.get("agents", "inspection")).spec).harnessRef).toMatchObject({
      name: "codex",
    });
    expect(object(before.spec).harnessRef).not.toMatchObject({ name: "codex" });
  });

  it("protects preset Harness ownership and the console's system assistants", async () => {
    const current = await env.store.get("harnesses", "standard");
    await expect(
      client.deleteHarness({
        ref: ref("standard"),
        resourceVersion: text(object(current.metadata).resourceVersion),
      }),
    ).rejects.toThrow("harness.presetProtected");
    await expect(client.getEngineerRuntime({ ref: ref("assistant") })).rejects.toThrow(
      "harness.invalidEngineer",
    );
  });
});
