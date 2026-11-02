import { create } from "@bufbuild/protobuf";
import { useQuery } from "@tanstack/react-query";
import {
  type AuthorizationResource,
  AuthorizationResourceSchema,
  AuthorizationScopeKind,
  Permission,
} from "../../gen/kagent/api/v1/authorization_pb.js";
import { useAccess } from "./access.js";
import { authorizationClient } from "./console.js";

export function authorizationScopeKind(scope: AuthorizationResource) {
  switch (scope.resource.case) {
    case "workspace":
      return AuthorizationScopeKind.WORKSPACE;
    case "kubernetes":
      return scope.resource.value.kind;
    case "sessionId":
      return AuthorizationScopeKind.SESSION;
    case "task":
      return AuthorizationScopeKind.TASK;
    default:
      return AuthorizationScopeKind.UNSPECIFIED;
  }
}

export function useResourceAccess(scope: AuthorizationResource | undefined) {
  const profile = useAccess().data;
  const workspace = profile?.workspace;
  const subject = profile?.subject ?? "";
  const permissions = [Permission.ACCESS_READ, Permission.ACCESS_MANAGE];
  if (scope?.resource.case === "sessionId" || scope?.resource.case === "task")
    permissions.push(Permission.SESSION_SHARE);
  return useQuery({
    queryKey: ["resource-authorization", subject, workspace?.uid, "permissions", scope],
    queryFn: async ({ signal }) => {
      const result = await authorizationClient.checkPermissions(
        { workspace, checks: [{ resource: scope, permissions }] },
        { signal, timeoutMs: 10_000 },
      );
      return result.resources[0];
    },
    enabled: !!scope && !!workspace && !!subject,
    retry: false,
    refetchInterval: 10_000,
  });
}

export function useAgentAccess(names: string[]) {
  const profile = useAccess().data;
  const workspace = profile?.workspace;
  const subject = profile?.subject ?? "";
  const uniqueNames = [...new Set(names.filter(Boolean))].sort();
  return useQuery({
    queryKey: ["resource-authorization", subject, workspace?.uid, "agent-access", uniqueNames],
    queryFn: async ({ signal }) => {
      const allowed: string[] = [];
      for (let offset = 0; offset < uniqueNames.length; offset += 50) {
        const batch = uniqueNames.slice(offset, offset + 50);
        const { resources } = await authorizationClient.checkPermissions(
          {
            workspace,
            checks: batch.map((name) => ({
              resource: create(AuthorizationResourceSchema, {
                resource: {
                  case: "kubernetes",
                  value: {
                    kind: AuthorizationScopeKind.AGENT,
                    ref: { namespace: workspace?.namespace ?? "", name },
                  },
                },
              }),
              permissions: [Permission.ACCESS_READ],
            })),
          },
          { signal, timeoutMs: 10_000 },
        );
        resources.forEach((resource, index) => {
          if (resource.allowedActions.includes(Permission.ACCESS_READ)) allowed.push(batch[index]);
        });
      }
      return allowed;
    },
    enabled: !!workspace && !!subject && uniqueNames.length > 0,
    retry: false,
    refetchInterval: 10_000,
  });
}
