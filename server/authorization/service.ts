import type { HandlerContext, ServiceImpl } from "@connectrpc/connect";
import type { AuthorizationService } from "../../gen/kagent/api/v1/authorization_pb.js";
import type { KagentClients } from "../kagent/clients.js";
import { credentialHeaders } from "../kagent/context.js";

/** Native authorization verifies workspace membership and scoped role decisions. */
export function authorizationService(
  client: KagentClients["authorization"],
): ServiceImpl<typeof AuthorizationService> {
  const options = (context: HandlerContext) => ({
    headers: credentialHeaders(context.requestHeader),
    signal: context.signal,
    timeoutMs: 10_000,
  });
  return {
    listAccessRoles: (request, context) => client.listAccessRoles(request, options(context)),
    listWorkspaces: (request, context) => client.listWorkspaces(request, options(context)),
    checkPermissions: (request, context) => client.checkPermissions(request, options(context)),
    listRoleBindings: (request, context) => client.listRoleBindings(request, options(context)),
    grantRole: (request, context) => client.grantRole(request, options(context)),
    revokeRole: (request, context) => client.revokeRole(request, options(context)),
  };
}
