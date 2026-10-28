import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient, createRouterTransport } from "@connectrpc/connect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ConnectionKind,
  ConnectionSchema,
  ManagementService,
  ModelPurpose,
} from "../gen/agentos/management/v1/management_pb.js";
import { ModelConfigSchema } from "../gen/kagent/api/v1/models_pb.js";
import { object, text } from "../server/read-model/decode/messages.js";
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
afterEach(async () => {
  await env.close();
});

const connection = (name: string, kind = ConnectionKind.MODEL) =>
  create(ConnectionSchema, {
    kind,
    resource: {
      apiVersion: "agentgateway.dev/v1alpha1",
      kind: kind === ConnectionKind.MODEL ? "AgentgatewayModel" : "AgentgatewayBackend",
      value: {
        apiVersion: "agentgateway.dev/v1alpha1",
        kind: kind === ConnectionKind.MODEL ? "AgentgatewayModel" : "AgentgatewayBackend",
        metadata: { name, namespace: "agentos" },
        spec:
          kind === ConnectionKind.MODEL
            ? {
                provider: "OpenAI",
                baseURL: "https://provider.example/v1",
                match: { model: "gpt-6.1-sol" },
              }
            : {
                mcp: {
                  targets: [
                    { name: "server", static: { host: "mcp.example", port: 443, path: "/mcp" } },
                  ],
                },
              },
      },
    },
  });

describe("native gateway connections", () => {
  it("filters embedding connections before pagination and preserves their native purpose", async () => {
    for (const name of ["vectors-a", "vectors-b"]) {
      const draft = connection(name);
      object(draft.resource?.value?.metadata).annotations = {
        "agentos.dev/model-purpose": "embedding",
      };
      await client.saveConnection({ connection: draft, create: true });
      const model = await env.store.get("models", name);
      expect(object(object(model.metadata).annotations)["agentos.dev/model-purpose"]).toBe(
        "embedding",
      );
    }
    const first = await client.listConnections({
      kind: ConnectionKind.MODEL,
      modelPurpose: ModelPurpose.EMBEDDING,
      query: "vectors-",
      pageSize: 1,
    });
    expect(first.totalSize).toBe(2);
    expect(first.connections).toHaveLength(1);
    const next = await client.listConnections({
      kind: ConnectionKind.MODEL,
      modelPurpose: ModelPurpose.EMBEDDING,
      query: "vectors-",
      pageSize: 1,
      pageToken: first.nextPageToken,
    });
    expect(next.connections).toHaveLength(1);
    expect(next.connections[0]?.resource?.value?.metadata).not.toEqual(
      first.connections[0]?.resource?.value?.metadata,
    );
    const language = await client.listConnections({
      kind: ConnectionKind.MODEL,
      modelPurpose: ModelPurpose.LANGUAGE,
      query: "vectors-",
    });
    expect(language.totalSize).toBe(0);
  });
  it("switches the native client protocol without bypassing the gateway or retaining cleared options", async () => {
    const draft = connection("harness-model");
    draft.model = create(ModelConfigSchema, {
      resource: {
        value: {
          spec: {
            provider: "OpenAI",
            openAI: {
              apiFormat: "responses",
              maxCompletionTokens: 8192,
              reasoningEffort: "medium",
            },
          },
        },
      },
    });
    const { connection: initial } = await client.saveConnection({
      connection: draft,
      create: true,
    });
    if (!initial?.model?.resource?.value) throw new Error("native model missing");
    initial.model.resource.value.spec = { provider: "OpenAI", openAI: { apiFormat: "responses" } };
    const { connection: cleared } = await client.saveConnection({ connection: initial });
    const desired = JSON.parse(
      text(
        object(object((await env.store.get("models", "harness-model")).metadata).annotations)[
          "agentos.dev/model-config"
        ],
      ),
    );
    expect(desired).toEqual({ provider: "OpenAI", openAI: { apiFormat: "responses" } });
    if (!cleared?.model?.resource?.value) throw new Error("native model missing");
    cleared.model.resource.value.spec = { provider: "Anthropic", anthropic: {} };
    await client.saveConnection({ connection: cleared });
    const native = JSON.parse(
      text(
        object(object((await env.store.get("models", "harness-model")).metadata).annotations)[
          "agentos.dev/model-config"
        ],
      ),
    );
    expect(native).toEqual({ provider: "Anthropic", anthropic: {} });
    await expect(env.store.get("modelConfigs", "harness-model")).rejects.toMatchObject({
      code: Code.NotFound,
    });
    expect(object((await env.store.get("models", "harness-model")).spec).provider).toBe("OpenAI");
  });
  it("creates a model consumer through the gateway and returns only secret references", async () => {
    const saved = await client.saveConnection({
      connection: connection("model-smoke"),
      create: true,
      credential: "provider-secret",
    });
    expect(JSON.stringify(saved)).not.toContain("provider-secret");
    await expect(env.store.get("modelConfigs", "model-smoke")).rejects.toMatchObject({
      code: Code.NotFound,
    });
    const secret = env.fake.resources.get("secrets", "agentos-model-model-smoke");
    expect(Buffer.from(text(object(secret.data).Authorization), "base64").toString()).toBe(
      "provider-secret",
    );
    expect(object(secret.metadata).ownerReferences).toMatchObject([
      { uid: object(saved.connection?.resource?.value?.metadata).uid },
    ]);
    const list = await client.listConnections({ kind: ConnectionKind.MODEL });
    expect(
      list.connections.find(
        (item) => object(item.resource?.value?.metadata).name === "default-model-config",
      )?.usedBy,
    ).toContain("inspection");
  });
  it("version-checks updates and refuses deletion of active or built-in connections", async () => {
    const { connection: first } = await client.saveConnection({
      connection: connection("versioned"),
      create: true,
    });
    const updated = await client.saveConnection({ connection: first });
    expect(object(object(first?.resource?.value?.spec).policies).auth).toBeUndefined();
    await expect(client.saveConnection({ connection: first })).rejects.toMatchObject({
      code: Code.Aborted,
    });
    await expect(env.store.get("modelConfigs", "versioned")).rejects.toMatchObject({
      code: Code.NotFound,
    });
    expect(object(updated.connection?.resource?.value?.metadata).resourceVersion).not.toBe(
      object(first?.resource?.value?.metadata).resourceVersion,
    );
    const builtin = await env.store.get("models", "knowledge-embedding");
    await expect(
      client.deleteConnection({
        kind: ConnectionKind.MODEL,
        name: "knowledge-embedding",
        resourceVersion: text(object(builtin.metadata).resourceVersion),
      }),
    ).rejects.toMatchObject({ code: Code.FailedPrecondition });
    const used = await env.store.get("models", "default-model-config");
    await expect(
      client.deleteConnection({
        kind: ConnectionKind.MODEL,
        name: "default-model-config",
        resourceVersion: text(object(used.metadata).resourceVersion),
      }),
    ).rejects.toMatchObject({ code: Code.FailedPrecondition });
  });
  it("registers MCP through one gateway route and preserves native tool names", async () => {
    const { connection: saved } = await client.saveConnection({
      connection: connection("new-mcp", ConnectionKind.MCP),
      create: true,
    });
    const backend = saved?.resource?.value ?? {};
    const policies = object(object(backend.spec).policies);
    expect(object(policies.mcp).authorization).toBeUndefined();
    expect(object(object(policies.transformation).request).remove).toEqual([
      "x-substrate-actor-token",
      "cookie",
      "x-forwarded-access-token",
    ]);
    expect(object(object(backend.spec).mcp).prefixMode).toBe("Never");
    expect(object(object(backend.spec).mcp).targets).toMatchObject([
      { static: { policies: { http: { requestTimeout: "10m" } } } },
    ]);
    if (!saved?.resource) throw new Error("Connection resource missing");
    const supplied = structuredClone(backend);
    object(supplied.spec).policies = {
      ...policies,
      mcp: { authorization: { action: "Allow" } },
    };
    const { connection: updated } = await client.saveConnection({
      connection: { ...saved, resource: { ...saved.resource, value: supplied } },
    });
    expect(
      object(object(object(updated?.resource?.value?.spec).policies).mcp).authorization,
    ).toBeUndefined();
    await expect(env.store.get("remoteMCPs", "new-mcp")).rejects.toMatchObject({
      code: Code.NotFound,
    });
    await expect(env.store.get("routes", "mcp-new-mcp")).rejects.toMatchObject({
      code: Code.NotFound,
    });
    await client.deleteConnection({
      kind: ConnectionKind.MCP,
      name: "new-mcp",
      resourceVersion: text(object(updated?.resource?.value?.metadata).resourceVersion),
    });
    await expect(env.store.get("remoteMCPs", "new-mcp")).rejects.toMatchObject({
      code: Code.NotFound,
    });
    await expect(env.store.get("routes", "mcp-new-mcp")).rejects.toMatchObject({
      code: Code.NotFound,
    });
  });
  it("retains the committed parent for retry and leaves foreign credentials untouched", async () => {
    const foreign = await env.store.get("modelConfigs", "default-model-config");
    await expect(
      client.saveConnection({ connection: connection("default-model-config"), create: true }),
    ).rejects.toMatchObject({ code: Code.Aborted });
    expect(await env.store.get("modelConfigs", "default-model-config")).toEqual(foreign);
    env.fake.resources.save(
      "secrets",
      {
        apiVersion: "v1",
        kind: "Secret",
        metadata: { name: "agentos-model-owned" },
        data: { Authorization: Buffer.from("other-secret").toString("base64") },
      },
      true,
    );
    await expect(
      client.saveConnection({
        connection: connection("owned"),
        create: true,
        credential: "new-secret",
      }),
    ).rejects.toMatchObject({ code: Code.InvalidArgument });
    expect(object((await env.store.get("models", "owned")).metadata).name).toBe("owned");
    const value = env.fake.resources.get("secrets", "agentos-model-owned");
    expect(Buffer.from(text(object(value.data).Authorization), "base64").toString()).toBe(
      "other-secret",
    );
  });
});

describe("shared skill catalog", () => {
  it("validates native sources, preserves ConfigMap metadata and prevents stale updates", async () => {
    const validate = vi.spyOn(env.store, "validate");
    const skill = {
      name: "triage",
      source: { case: "oci" as const, value: `registry.example/triage@sha256:${"a".repeat(64)}` },
    };
    const { item } = await client.saveSkill({
      create: true,
      item: { skill, description: "Triage procedures" },
    });
    expect(validate).toHaveBeenCalledWith(
      "templates",
      expect.objectContaining({
        metadata: { generateName: "skill-validation-", namespace: "agentos" },
      }),
    );
    await client.saveSkill({
      item: { skill: item?.skill, resourceVersion: item?.resourceVersion, description: "Updated" },
    });
    await expect(client.saveSkill({ item })).rejects.toMatchObject({ code: Code.Aborted });
    const cm = env.fake.resources.get("configmaps", "agentos-skills");
    expect(object(object(cm.metadata).annotations)["agentos.dev/ownership"]).toBe("user");
    const { skills } = await client.listSkills({});
    expect(skills[0]?.description).toBe("Updated");
    await client.deleteSkill({ name: "triage", resourceVersion: skills[0]?.resourceVersion });
    expect((await client.listSkills({})).totalSize).toBe(0);
  });
});

describe("native knowledge memory", () => {
  it("deletes only the selected shared record and removes it from retrieval", async () => {
    const first = await client.addKnowledge({ content: "Selected knowledge" });
    const kept = await client.addKnowledge({ content: "Retained knowledge" });
    const foreign = await env.clients.memory.addSession({
      scope: { target: { case: "agentName", value: "agentos/private" } },
      memory: { content: "Other scope" },
    });
    await expect(client.deleteKnowledge({ id: foreign.id })).rejects.toMatchObject({
      code: Code.NotFound,
    });
    await client.deleteKnowledge({ id: first.id });
    expect((await client.listKnowledge({})).memories.map((item) => item.id)).toEqual([kept.id]);
    expect(
      (await client.searchKnowledge({ query: "knowledge" })).memories.map((item) => item.id),
    ).toEqual([kept.id]);
    expect(env.fake.memory.records.has(foreign.id)).toBe(true);
    await expect(client.deleteKnowledge({ id: first.id })).rejects.toMatchObject({
      code: Code.NotFound,
    });
    expect(env.fake.memory.records.size).toBe(2);
  });

  it("never falls back to clearing knowledge when the native single-delete RPC is unavailable", async () => {
    const { id } = await client.addKnowledge({ content: "Keep when native controller is old" });
    const clear = vi.spyOn(env.clients.memory, "delete");
    vi.spyOn(env.clients.memory, "deleteEntry").mockRejectedValueOnce(
      new ConnectError("Unimplemented", Code.Unimplemented),
    );
    await expect(client.deleteKnowledge({ id })).rejects.toMatchObject({ code: Code.Unavailable });
    expect(clear).not.toHaveBeenCalled();
    expect((await client.listKnowledge({})).totalSize).toBe(1);
  });
  it("sends plain content to the native team scope and isolates personal memory", async () => {
    const { id } = await client.addKnowledge({
      content: "Drain a node only after approval.",
    });
    const record = env.fake.memory.records.get(id);
    expect(record).toMatchObject({
      scope: "team:agentos",
      input: { ttlDays: 3650 },
    });
    expect(record?.input.vector).toEqual([]);
    expect((await client.searchKnowledge({ query: "node drain" })).memories[0]?.id).toBe(id);
    expect((await client.listKnowledge({})).memories[0]?.accessCount).toBe(1n);
    await env.clients.memory.addSession({
      scope: { target: { case: "agentName", value: "agentos/private" } },
      memory: { content: "Private memory" },
    });
    expect((await client.listKnowledge({})).totalSize).toBe(1);
    await expect(client.clearKnowledge({ etag: "0".repeat(64) })).rejects.toMatchObject({
      code: Code.Aborted,
    });
    expect(env.fake.memory.records.size).toBe(2);
    await client.clearKnowledge({ etag: (await client.listKnowledge({})).etag });
    expect((await client.listKnowledge({})).totalSize).toBe(0);
    expect(env.fake.memory.records.size).toBe(1);
  });
});
