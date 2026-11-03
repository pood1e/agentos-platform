import { create, type JsonObject, type JsonValue, type MessageInitShape } from "@bufbuild/protobuf";
import {
  type RoleDefinition,
  RoleDefinitionSchema,
  type Skill,
  type SkillSchema,
  type ToolBinding,
} from "../../gen/agentos/console/v1/role_pb.js";
import type { AgentTemplate } from "../../gen/kagent/api/v1/agent_templates_pb.js";
import { object, text } from "../../shared/json.js";
import { displayNameAnnotation } from "../../shared/kagent-resources.js";

const strings = (value: JsonValue | undefined) =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
const objects = (value: JsonValue | undefined) => (Array.isArray(value) ? value.map(object) : []);

function skill(entry: JsonObject): MessageInitShape<typeof SkillSchema>["source"] {
  const source = object(entry.source);
  if (typeof source.oci === "string") return { case: "oci", value: source.oci };
  if (source.git !== undefined) {
    const git = object(source.git);
    return { case: "git", value: { url: text(git.url), commit: text(git.commit) } };
  }
  const s3 = object(object(source.bucket).s3);
  return {
    case: "bucket",
    value: {
      endpoint: text(s3.endpoint),
      bucket: text(s3.bucket),
      key: text(s3.key),
      versionId: text(s3.versionId),
      region: text(s3.region),
    },
  };
}

/** The tool selection of one native `spec.tools` entry. */
export function bindingFromSpec(entry: JsonObject) {
  const mcp = object(entry.mcp);
  return {
    server: text(object(mcp.server).name),
    tools: strings(mcp.tools),
    requireApproval: mcp.requireApproval === true,
  };
}

export const bindingSpec = (
  binding: Pick<ToolBinding, "server" | "tools" | "requireApproval">,
) => ({
  mcp: {
    server: { kind: "RemoteMCPServer", name: binding.server },
    tools: binding.tools,
    requireApproval: binding.requireApproval,
  },
});

export function roleDefinition(template: AgentTemplate): RoleDefinition {
  const value = template.resource?.value;
  const metadata = object(value?.metadata);
  const spec = object(value?.spec);
  return create(RoleDefinitionSchema, {
    name: template.ref?.name ?? text(metadata.name),
    displayName: text(object(metadata.annotations)[displayNameAnnotation]),
    description: text(spec.description),
    systemPrompt: text(spec.systemPrompt),
    tools: objects(spec.tools).flatMap((binding) =>
      binding.mcp === undefined ? [] : [bindingFromSpec(binding)],
    ),
    skills: objects(spec.skills).map((entry) => ({
      name: text(entry.name),
      source: skill(entry),
      path: text(object(entry.source).path),
    })),
    resourceVersion: text(metadata.resourceVersion),
    modelConfig: { name: text(object(spec.modelConfig).name), namespace: text(metadata.namespace) },
  });
}

export function skillSource(skill: Skill): JsonObject {
  const source: JsonObject = {};
  if (skill.source.case === "oci") source.oci = skill.source.value;
  if (skill.source.case === "git")
    source.git = { url: skill.source.value.url, commit: skill.source.value.commit };
  if (skill.source.case === "bucket") {
    const { endpoint, bucket, key, versionId, region } = skill.source.value;
    const s3: JsonObject = { endpoint, bucket, key, versionId };
    if (region) s3.region = region;
    source.bucket = { s3 };
  }
  if (skill.path) source.path = skill.path;
  return source;
}

/** Template spec for a role; unrelated fields such as modelConfig are preserved. */
export function templateSpec(role: RoleDefinition, previous: JsonObject): JsonObject {
  const spec = { ...previous };
  delete spec.systemPromptFrom;
  return {
    ...spec,
    ...(role.modelConfig?.name ? { modelConfig: { name: role.modelConfig.name } } : {}),
    description: role.description,
    systemPrompt: role.systemPrompt,
    tools: role.tools.map(bindingSpec),
    skills: role.skills.map((entry) => ({ name: entry.name, source: skillSource(entry) })),
  };
}
