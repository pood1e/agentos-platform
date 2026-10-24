import type { JsonObject } from "@bufbuild/protobuf";
import type { Connection } from "../../gen/agentos/management/v1/management_pb.js";
import { modelPurposeAnnotation } from "../../shared/model-purpose.js";
import { object, text } from "../read-model/decode/messages.js";
import { invalid } from "../shared/errors.js";
import { type GatewayConfig, meta, optional, ownerFor } from "./native.js";
import type { ResourceKind, ResourceStore } from "./resources.js";

export function connectionBindings(store: ResourceStore, gateway: GatewayConfig) {
  async function child(kind: ResourceKind, value: JsonObject, parent: JsonObject) {
    const name = text(meta(value).name);
    const existing = await optional(store, kind, name);
    return store.save(
      kind,
      {
        ...value,
        metadata: {
          ...meta(existing ?? {}),
          ...meta(value),
          namespace: gateway.namespace,
          ownerReferences: ownerFor(parent),
        },
      },
      !existing,
    );
  }
  async function bindModel(parent: JsonObject, connection: Connection) {
    const name = text(meta(parent).name);
    const spec = object(parent.spec);
    const model = text(object(spec.match).model) || name;
    const old = await optional(store, "modelConfigs", name);
    const supplied = object(connection.model?.resource?.value?.spec);
    const previous = Object.keys(supplied).length ? supplied : object(old?.spec);
    const actual = model.includes("*") ? text(previous.model) : model;
    if (!actual || actual.includes("*")) throw invalid("management.concreteModelRequired");
    const anthropic = previous.provider === "Anthropic";
    await child(
      "modelConfigs",
      {
        apiVersion: "api.kagent.dev/v1alpha3",
        kind: "ModelConfig",
        metadata: {
          name,
          annotations: {
            [modelPurposeAnnotation]:
              text(object(meta(parent).annotations)[modelPurposeAnnotation]) || "language",
          },
        },
        spec: {
          ...(previous.stream !== undefined ? { stream: previous.stream } : {}),
          provider: anthropic ? "Anthropic" : "OpenAI",
          model: actual,
          apiKeySecret: gateway.secret,
          apiKeySecretKey: "placeholder",
          ...(anthropic
            ? { anthropic: { ...object(previous.anthropic), baseUrl: gateway.url } }
            : {
                openAI: {
                  ...object(previous.openAI),
                  baseUrl: `${gateway.url}/v1`,
                  apiFormat: text(object(previous.openAI).apiFormat) || "responses",
                },
              }),
        },
      },
      parent,
    );
  }
  async function bindMCP(parent: JsonObject) {
    if (object(meta(parent).labels)["agentos.dev/environment"]) return;
    const name = text(meta(parent).name);
    await child(
      "routes",
      {
        apiVersion: "gateway.networking.k8s.io/v1",
        kind: "HTTPRoute",
        metadata: { name: `mcp-${name}` },
        spec: {
          parentRefs: [{ name: gateway.name, sectionName: "http" }],
          rules: [
            {
              matches: [{ path: { type: "PathPrefix", value: `/mcp/${name}` } }],
              backendRefs: [{ group: "agentgateway.dev", kind: "AgentgatewayBackend", name }],
            },
          ],
        },
      },
      parent,
    );
    await child(
      "remoteMCPs",
      {
        apiVersion: "api.kagent.dev/v1alpha3",
        kind: "RemoteMCPServer",
        metadata: { name, annotations: { "agentos.dev/discovery-auth": "kubernetes" } },
        spec: {
          description: text(object(meta(parent).annotations)["agentos.dev/description"]) || name,
          protocol: "STREAMABLE_HTTP",
          url: `${gateway.mcpUrl}/mcp/${name}`,
          timeout: "10m",
        },
      },
      parent,
    );
  }
  return { bindModel, bindMCP };
}
