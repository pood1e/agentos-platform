import { toJsonString } from "@bufbuild/protobuf";
import {
  AuthorizationResourceSchema,
  type RoleBinding,
  type SubjectReference,
  SubjectReferenceSchema,
} from "../../../gen/kagent/api/v1/authorization_pb.js";

export interface RoleBindingGroup {
  key: string;
  subject: SubjectReference | undefined;
  bindings: RoleBinding[];
}

export function groupRoleBindings(bindings: readonly RoleBinding[]): RoleBindingGroup[] {
  const groups = new Map<string, RoleBindingGroup>();
  for (const binding of bindings) {
    const key = JSON.stringify([
      binding.subject ? toJsonString(SubjectReferenceSchema, binding.subject) : "",
      binding.scope ? toJsonString(AuthorizationResourceSchema, binding.scope) : "",
    ]);
    let group = groups.get(key);
    if (!group) {
      group = { key, subject: binding.subject, bindings: [] };
      groups.set(key, group);
    }
    if (!group.bindings.some((value) => value.role === binding.role)) group.bindings.push(binding);
  }
  return [...groups.values()].map((group) => ({
    ...group,
    bindings: group.bindings.toSorted((left, right) => left.role - right.role),
  }));
}
