import { useQuery } from "@tanstack/react-query";
import {
  type AuthorizationResource,
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
  const workspace = profile?.workspace ?? "";
  const subject = profile?.subject ?? "";
  const permissions = [Permission.ACCESS_READ, Permission.ACCESS_MANAGE];
  if (scope?.resource.case === "sessionId" || scope?.resource.case === "task")
    permissions.push(Permission.SESSION_SHARE);
  return useQuery({
    queryKey: ["resource-authorization", subject, workspace, "permissions", scope],
    queryFn: async ({ signal }) => {
      const result = await authorizationClient.checkPermissions(
        { workspace: { namespace: workspace }, checks: [{ resource: scope, permissions }] },
        { signal, timeoutMs: 10_000 },
      );
      return result.resources[0];
    },
    enabled: !!scope && !!workspace && !!subject,
    retry: false,
    refetchInterval: 10_000,
  });
}
