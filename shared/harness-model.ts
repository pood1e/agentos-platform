import type { JsonObject, JsonValue } from "@bufbuild/protobuf";
import type { ToolServer } from "../gen/kagent/api/v1alpha1/tools_pb.js";

const configured = (value: JsonValue | undefined): boolean =>
  Array.isArray(value)
    ? value.some(configured)
    : value !== null && typeof value === "object"
      ? Object.values(value).some(configured)
      : Boolean(value);

function options(value: JsonValue | undefined, allowed: string[], runtime: string) {
  return Object.entries((value ?? {}) as JsonObject).some(
    ([key, value]) =>
      !allowed.includes(key) &&
      !(runtime === "claude" && key === "cacheTTL" && value === "5m") &&
      configured(value),
  );
}

/** Model constraints of the pinned native Harness adapters, shared by forms and validation. */
export function harnessModelIssue(runtime: string, spec: JsonObject): string | undefined {
  if (runtime !== "codex" && runtime !== "claude") return;
  const provider = String(spec.provider ?? "");
  const allowed =
    runtime === "codex" ? ["OpenAI", "Bedrock"] : ["Anthropic", "Bedrock", "AnthropicVertexAI"];
  if (!allowed.includes(provider)) return "harness.incompatibleModel";
  if (configured(spec.defaultHeaders) || configured(spec.tls) || spec.apiKeyPassthrough === true)
    return "harness.modelOptions";
  if (runtime === "codex" && provider === "OpenAI") {
    if ((spec.openAI as JsonObject | undefined)?.apiFormat !== "responses")
      return "harness.responsesRequired";
    if (options(spec.openAI, ["baseUrl", "apiFormat"], runtime)) return "harness.modelOptions";
  }
  if (
    (provider === "Anthropic" && options(spec.anthropic, ["baseUrl"], runtime)) ||
    (provider === "Bedrock" && options(spec.bedrock, ["region"], runtime)) ||
    (provider === "AnthropicVertexAI" &&
      options(spec.anthropicVertexAI, ["projectID", "location"], runtime))
  )
    return "harness.modelOptions";
  if (runtime === "codex" && provider === "Bedrock" && !String(spec.model ?? "").startsWith("gpt-"))
    return "harness.incompatibleModel";
}

export function harnessToolsIssue(
  runtime: string,
  template: JsonObject,
  namespace: string,
  servers: ToolServer[],
): string | undefined {
  if (runtime !== "codex" && runtime !== "claude") return;
  for (const tool of Array.isArray(template.tools) ? template.tools : []) {
    const mcp = (tool as JsonObject).mcp as JsonObject | undefined;
    if (!mcp?.server) continue;
    const name = (mcp.server as JsonObject).name;
    const server = servers.find((item) => item.ref === `${namespace}/${name}`);
    if (!server) return "configuration.invalidTools";
    if (
      Array.isArray(mcp.tools) &&
      mcp.tools.some((name) => !server.discoveredTools.some((tool) => tool.name === name))
    )
      return "configuration.invalidTools";
  }
}
