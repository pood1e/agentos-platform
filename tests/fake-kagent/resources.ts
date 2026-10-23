import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { type JsonObject, create as makeMessage } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { parse } from "yaml";
import { AgentSchema } from "../../gen/kagent/api/v1/agents_pb.js";
import { object, text } from "../../server/read-model/decode/messages.js";
import type { FakeKagent } from "./kagent.js";

const harnesses = object(
  parse(readFileSync(new URL("../../charts/agentos/values.yaml", import.meta.url), "utf8")),
).harnesses;

export class FakeResources {
  readonly data = new Map<string, Map<string, JsonObject>>();
  private version = 0;
  constructor(private readonly fake: FakeKagent) {
    this.reset();
  }
  reset() {
    this.data.clear();
    this.version = 0;
    this.save(
      "secrets",
      {
        apiVersion: "v1",
        kind: "Secret",
        metadata: { name: "agentos-speech" },
        data: { "configuration.json": Buffer.from("{}").toString("base64") },
      },
      true,
    );
    this.save(
      "configmaps",
      {
        apiVersion: "v1",
        kind: "ConfigMap",
        metadata: { name: "agentos-skills", annotations: { "helm.sh/resource-policy": "keep" } },
        data: { "catalog.json": "{}" },
      },
      true,
    );
    for (const [name, spec] of Object.entries(object(harnesses)))
      this.save(
        "harnesses",
        {
          apiVersion: "api.kagent.dev/v1alpha3",
          kind: "Harness",
          metadata: { name, labels: { "app.kubernetes.io/managed-by": "Helm" } },
          spec,
        },
        true,
      );
    for (const agent of this.fake.agents) {
      const value = agent.resource?.value;
      if (!value) continue;
      value.metadata = {
        ...object(value.metadata),
        name: agent.ref?.name ?? "",
        namespace: agent.ref?.namespace ?? "agentos",
        uid: object(value.metadata).uid ?? randomUUID(),
        generation: object(value.metadata).generation ?? 1,
        resourceVersion: String(++this.version),
      };
    }
    for (const name of ["default-model-config", "knowledge-embedding"]) {
      const model = name === "knowledge-embedding" ? "embeddinggemma:300m" : "gpt-6.1-sol";
      this.save(
        "agentgatewaymodels",
        {
          apiVersion: "agentgateway.dev/v1alpha1",
          kind: "AgentgatewayModel",
          metadata: {
            name,
            annotations: {
              "agentos.dev/system-connection": String(name === "knowledge-embedding"),
            },
          },
          spec: { provider: "OpenAI", baseURL: "https://provider.example/v1", match: { model } },
          status: { parents: [{ conditions: [{ type: "Accepted", status: "True" }] }] },
        },
        true,
      );
      this.save(
        "modelconfigs",
        {
          apiVersion: "api.kagent.dev/v1alpha3",
          kind: "ModelConfig",
          metadata: { name },
          spec: {
            provider: "OpenAI",
            model,
            apiKeySecret: "agentos-gateway",
            apiKeySecretKey: "api-key",
            openAI: { baseUrl: "http://agentos-gateway:8080/v1", apiFormat: "responses" },
          },
        },
        true,
      );
    }
    for (const server of this.fake.toolServers) {
      const name = server.ref.split("/").at(-1) ?? "";
      this.save(
        "agentgatewaybackends",
        {
          apiVersion: "agentgateway.dev/v1alpha1",
          kind: "AgentgatewayBackend",
          metadata: {
            name,
            annotations: {
              "agentos.dev/system-connection": String(
                ["team-sessions", "kagent-collaboration"].includes(name),
              ),
            },
          },
          spec: {
            mcp: {
              prefixMode: "Never",
              targets: [
                {
                  name,
                  static: {
                    host: "mcp.example",
                    port: 8084,
                    path: "/mcp",
                    protocol: "StreamableHTTP",
                  },
                },
              ],
            },
          },
        },
        true,
      );
      this.save(
        "remotemcpservers",
        {
          apiVersion: "api.kagent.dev/v1alpha3",
          kind: "RemoteMCPServer",
          metadata: { name },
          spec: { url: `http://agentos-gateway:8080/mcp/${name}` },
        },
        true,
      );
    }
  }
  list(plural: string): JsonObject[] {
    if (plural === "agenttemplates")
      return [...this.fake.templates.values()].map((item) => item.resource?.value ?? {});
    if (plural === "agents")
      return this.fake.agents.map((item) => ({
        ...item.resource?.value,
        metadata: {
          ...object(item.resource?.value?.metadata),
          namespace: item.ref?.namespace ?? "agentos",
          name: item.ref?.name ?? "",
        },
      }));
    return [...(this.data.get(plural)?.values() ?? [])];
  }
  get(plural: string, name: string) {
    const value = this.list(plural).find((item) => object(item.metadata).name === name);
    if (!value) throw new ConnectError("Not found", Code.NotFound);
    return structuredClone(value);
  }
  save(plural: string, value: JsonObject, create: boolean) {
    const metadata = object(value.metadata);
    const name = text(metadata.name);
    const items = this.data.get(plural) ?? new Map<string, JsonObject>();
    const old =
      plural === "agents"
        ? this.fake.agents.find((item) => item.ref?.name === name)?.resource?.value
        : items.get(name);
    if (create && old) throw new ConnectError("Already exists", Code.AlreadyExists);
    if (!create && !old) throw new ConnectError("Not found", Code.NotFound);
    if (old && object(old.metadata).resourceVersion !== metadata.resourceVersion)
      throw new ConnectError("Conflict", Code.Aborted);
    const result: JsonObject = structuredClone({
      ...value,
      metadata: {
        ...metadata,
        namespace: "agentos",
        uid: object(old?.metadata).uid ?? randomUUID(),
        generation: old
          ? Number(object(old.metadata).generation ?? 1) +
            (isDeepStrictEqual(old.spec, value.spec) ? 0 : 1)
          : 1,
        resourceVersion: String(++this.version),
      },
    });
    if (plural === "agents" && old?.status !== undefined && result.status === undefined)
      result.status = structuredClone(old.status);
    if (result.stringData) {
      result.data = Object.fromEntries(
        Object.entries(object(result.stringData)).map(([key, item]) => [
          key,
          Buffer.from(String(item)).toString("base64"),
        ]),
      );
      delete result.stringData;
    }
    items.set(name, result);
    this.data.set(plural, items);
    if (plural === "agents") {
      const agent = makeMessage(AgentSchema, {
        ref: { name, namespace: "agentos" },
        resource: { apiVersion: String(result.apiVersion), kind: "Agent", value: result },
      });
      const index = this.fake.agents.findIndex((item) => item.ref?.name === name);
      if (index < 0) this.fake.agents.push(agent);
      else this.fake.agents[index] = agent;
    }
    return structuredClone(result);
  }
  remove(plural: string, name: string, version: string) {
    const value = this.get(plural, name);
    if (object(value.metadata).resourceVersion !== version)
      throw new ConnectError("Conflict", Code.Aborted);
    this.data.get(plural)?.delete(name);
    const uid = object(value.metadata).uid;
    for (const [childPlural, children] of this.data)
      for (const [childName, child] of children) {
        const owners = object(child.metadata).ownerReferences;
        if (Array.isArray(owners) && owners.some((owner) => object(owner).uid === uid))
          this.remove(childPlural, childName, text(object(child.metadata).resourceVersion));
      }
  }
}
