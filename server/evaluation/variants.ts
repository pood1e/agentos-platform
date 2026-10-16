import { createHash } from "node:crypto";
import type { JsonObject, JsonValue } from "@bufbuild/protobuf";
import type { ConfigurationSnapshot } from "../../gen/agentos/evaluation/v1/evaluation_pb.js";
import {
  logicalPlatformServer,
  platformProfile,
  platformServices,
} from "../../shared/platform-tools.js";
import { meta } from "../management/native.js";
import { serverTargets } from "../operations/bindings.js";
import { object, text } from "../read-model/decode/messages.js";

export type Variant = "candidate" | "released";
export const variantPrefix = (id: string, variant: Variant) =>
  `e${id.replaceAll("-", "").slice(0, 16)}${variant[0]}-`;
export const variantName = (prefix: string, name: string) =>
  prefix.length + name.length <= 63
    ? `${prefix}${name}`
    : `${prefix}${name.slice(0, 54 - prefix.length)}-${createHash("sha256").update(name).digest("hex").slice(0, 8)}`;

/** Both variants start from the same frozen resources; production MCPs are never copied. */
export function evaluationVariant(
  snapshot: ConfigurationSnapshot,
  variant: Variant,
  namespace: string,
  prefix: string,
  platformMcpUrl: string,
) {
  const values = new Map(
    snapshot.resources.flatMap((entry) =>
      entry.value
        ? [[`${entry.kind}/${meta(entry.value).name}`, structuredClone(entry.value)] as const]
        : [],
    ),
  );
  if (variant === "candidate")
    for (const proposal of snapshot.proposals) {
      const entry = proposal.resource;
      if (!entry?.value) continue;
      if (proposal.delete) values.delete(`${entry.kind}/${meta(entry.value).name}`);
      else values.set(`${entry.kind}/${meta(entry.value).name}`, structuredClone(entry.value));
    }
  const native = [...values.values()];
  const targets = serverTargets(native.filter((value) => value.kind === "AgentgatewayBackend"));
  const remote = native.filter(
    (value) =>
      value.kind === "RemoteMCPServer" &&
      ((targets.get(text(meta(value).name))?.environment === snapshot.baseline?.environment &&
        targets.get(text(meta(value).name))?.access === "readOnly") ||
        platformServices.includes(text(meta(value).name) as (typeof platformServices)[number]) ||
        platformProfile(text(meta(value).name))),
  );
  const allowed = new Set(remote.map((value) => text(meta(value).name)));
  const remoteName = (name: string) => {
    const profile = platformProfile(name);
    if (profile) return `${profile.service}-${variantName(prefix, profile.role)}`;
    if (platformServices.includes(name as (typeof platformServices)[number]))
      return `${name}-${prefix}platform`;
    return variantName(prefix, name);
  };
  const gatewayName = `${prefix}gateway`;
  const result: JsonObject[] = [];
  for (const value of native) {
    const name = text(meta(value).name);
    if (
      ![
        "Agent",
        "AgentTemplate",
        "Harness",
        "ModelConfig",
        "AgentgatewayModel",
        "RemoteMCPServer",
      ].includes(text(value.kind))
    )
      continue;
    if (value.kind === "RemoteMCPServer" && !allowed.has(name)) continue;
    const spec = { ...object(value.spec) };
    if (value.kind === "AgentTemplate") {
      if (Array.isArray(spec.tools))
        spec.tools = spec.tools.filter((tool) =>
          allowed.has(text(object(object(object(tool).mcp).server).name)),
        );
      spec.modelConfig = localReference(spec.modelConfig, namespace, prefix);
      if (Array.isArray(spec.tools))
        spec.tools = spec.tools.map((tool) => {
          const mcp = object(object(tool).mcp);
          const original = object(mcp.server);
          return {
            mcp: {
              ...mcp,
              server: {
                ...original,
                name: platformServices.includes(
                  text(original.name) as (typeof platformServices)[number],
                )
                  ? `${text(original.name)}-${variantName(prefix, name)}`
                  : remoteName(text(original.name)),
              },
            },
          };
        });
    }
    if (value.kind === "Agent") {
      if (!spec.templateRef || !spec.harnessRef)
        throw new Error("Evaluation requires native template and harness references");
      spec.templateRef = localReference(spec.templateRef, namespace, prefix);
      spec.harnessRef = localReference(spec.harnessRef, namespace, prefix);
    }
    if (value.kind === "Harness") {
      const kagent = object(spec.kagent);
      if (kagent.memory) {
        const memory = object(kagent.memory);
        spec.kagent = {
          ...kagent,
          memory: {
            ...memory,
            modelConfigRef: localReference(memory.modelConfigRef, namespace, prefix),
          },
        };
      }
      if (Array.isArray(object(spec.workload).env))
        throw new Error("Evaluation harness environment must be compiler-owned");
    }
    if (value.kind === "ModelConfig") {
      spec.apiKeySecret = `${prefix}models`;
      spec.apiKeySecretKey = "api-key";
      const provider = text(spec.provider);
      const configKey = { OpenAI: "openAI", Anthropic: "anthropic" }[provider];
      if (!configKey)
        throw new Error("Evaluation model must use an agentgateway-supported provider");
      spec[configKey] = {
        ...object(spec[configKey]),
        baseUrl: `http://${gatewayName}.${namespace}.svc:8080${provider === "OpenAI" ? "/v1" : ""}`,
      };
    }
    if (value.kind === "AgentgatewayModel") {
      spec.parentRefs = [
        {
          group: "gateway.networking.k8s.io",
          kind: "Gateway",
          name: gatewayName,
          sectionName: "http",
        },
      ];
      spec.policies = remapSecrets(spec.policies, prefix);
    }
    if (value.kind === "RemoteMCPServer") {
      const profile = platformProfile(name);
      const service = profile?.service ?? logicalPlatformServer(name, "");
      if (platformServices.includes(service as (typeof platformServices)[number])) {
        spec.url = new URL(`/mcp/${service}`, platformMcpUrl).href;
        spec.headersFrom = [];
      } else spec.headersFrom = remapSecrets(spec.headersFrom, prefix);
    }
    result.push({
      apiVersion: value.apiVersion,
      kind: value.kind,
      metadata: {
        name: value.kind === "RemoteMCPServer" ? remoteName(name) : variantName(prefix, name),
        namespace,
        labels: { ...object(meta(value).labels), "agentos.dev/evaluation-prefix": prefix },
        annotations: object(meta(value).annotations),
      },
      spec,
    });
  }
  return { resources: result, source: native, remotes: remote, gatewayName };
}

function localReference(
  value: JsonValue | undefined,
  namespace: string,
  prefix: string,
): JsonObject {
  const reference = object(value);
  if (!reference.name) throw new Error("Native resource reference is missing");
  const result = { ...reference, name: variantName(prefix, text(reference.name)) };
  if ("namespace" in result) result.namespace = namespace;
  return result;
}

function remapSecrets(value: JsonValue | undefined, prefix: string): JsonValue {
  if (Array.isArray(value)) return value.map((entry) => remapSecrets(entry, prefix));
  if (!value || typeof value !== "object") return value ?? {};
  const result: JsonObject = {};
  for (const [key, item] of Object.entries(value)) {
    const ref = object(item);
    result[key] =
      (key === "secretRef" ||
        key === "secretKeyRef" ||
        (key === "valueFrom" && ref.type === "Secret")) &&
      ref.name
        ? { ...ref, name: variantName(prefix, text(ref.name)) }
        : remapSecrets(item, prefix);
  }
  return result;
}
