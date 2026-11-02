import { Code, ConnectError, type HandlerContext, type ServiceImpl } from "@connectrpc/connect";
import type {
  AuthorizationService,
  WorkspaceAuthorizationReference,
} from "../../gen/kagent/api/v1/authorization_pb.js";
import type { KagentClients } from "../kagent/clients.js";
import { credentialHeaders } from "../kagent/context.js";

/** Native authorization owns role semantics; the API pins the active workspace. */
export function authorizationService(
  client: KagentClients["authorization"],
  namespace: string,
): ServiceImpl<typeof AuthorizationService> {
  const scope = (request: { workspace?: WorkspaceAuthorizationReference }) => {
    if (request.workspace?.namespace !== namespace)
      throw new ConnectError("Workspace access denied", Code.PermissionDenied);
  };
  const options = (context: HandlerContext) => ({
    headers: credentialHeaders(context.requestHeader),
    signal: context.signal,
    timeoutMs: 10_000,
  });
  return {
    listAccessRoles: (request, context) => client.listAccessRoles(request, options(context)),
    checkPermissions(request, context) {
      scope(request);
      return client.checkPermissions(request, options(context));
    },
    listRoleBindings(request, context) {
      scope(request);
      return client.listRoleBindings(request, options(context));
    },
    grantRole(request, context) {
      scope(request);
      return client.grantRole(request, options(context));
    },
    revokeRole(request, context) {
      scope(request);
      return client.revokeRole(request, options(context));
    },
  };
}
