import { clone, create } from "@bufbuild/protobuf";
import {
  type RoleDefinition,
  RoleDefinitionSchema,
  type Skill,
  SkillSchema,
  ToolBindingSchema,
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

export const hasTool = (role: RoleDefinition, server: string, tool: string) =>
  role.tools.some((binding) => binding.server === server && binding.tools.includes(tool));

export const toolCount = (role: RoleDefinition) =>
  role.tools.reduce((count, binding) => count + binding.tools.length, 0);

/** Approval follows target execution requirements; the server applies the same rule when saving. */
export function toggleTool(
  role: RoleDefinition,
  requireApproval: boolean,
  server: string,
  tool: string,
  enabled: boolean,
) {
  return editRole(role, (draft) => {
    for (const binding of draft.tools)
      if (binding.server === server) binding.tools = binding.tools.filter((item) => item !== tool);
    if (enabled) {
      const binding = draft.tools.find(
        (item) => item.server === server && item.requireApproval === requireApproval,
      );
      if (binding) binding.tools.push(tool);
      else draft.tools.push(create(ToolBindingSchema, { server, tools: [tool], requireApproval }));
    }
    draft.tools = draft.tools.filter((binding) => binding.tools.length);
  });
}

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
