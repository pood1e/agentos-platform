import { clone, create } from "@bufbuild/protobuf";
import {
  type RoleDefinition,
  RoleDefinitionSchema,
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
