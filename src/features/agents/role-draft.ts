import { clone, create } from "@bufbuild/protobuf";
import {
  type RoleDefinition,
  RoleDefinitionSchema,
  type Skill,
  SkillSchema,
} from "../../../gen/agentos/console/v1/role_pb.js";

export const newRole = () =>
  create(RoleDefinitionSchema, {
    tools: [{ server: "kagent-collaboration", tools: ["search_memory"] }],
  });

export function editRole(role: RoleDefinition, change: (draft: RoleDefinition) => void) {
  const draft = clone(RoleDefinitionSchema, role);
  change(draft);
  return draft;
}

export const toolCount = (role: RoleDefinition) =>
  role.tools.reduce((count, binding) => count + binding.tools.length, 0);

export const skillKinds = ["oci", "git", "bucket"] as const;
export type SkillKind = (typeof skillKinds)[number];

export const newSkill = () => create(SkillSchema, { source: { case: "oci", value: "" } });

export function withKind(skill: Skill, kind: SkillKind): Skill {
  const next = clone(SkillSchema, skill);
  if (kind === "oci") next.source = { case: "oci", value: "" };
  if (kind === "git")
    next.source = create(SkillSchema, { source: { case: "git", value: {} } }).source;
  if (kind === "bucket")
    next.source = create(SkillSchema, { source: { case: "bucket", value: {} } }).source;
  return next;
}

export function editSkill(skill: Skill, change: (draft: Skill) => void) {
  const draft = clone(SkillSchema, skill);
  change(draft);
  return draft;
}
