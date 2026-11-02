import { Code, ConnectError, type HandlerContext, type ServiceImpl } from "@connectrpc/connect";
import type {
  AuthorizationService,
  ListWorkspacesRequest,
  WorkspaceAuthorizationReference,
} from "../../gen/kagent/api/v1/authorization_pb.js";
import type { KagentClients } from "../kagent/clients.js";
import { credentialHeaders } from "../kagent/context.js";
import { pageOf } from "../read-model/page.js";

type Client = KagentClients["authorization"];

/** Every configured native authority is queried for membership in its own namespace. */
export function authorizationService(
  clients: ReadonlyMap<string, Client>,
  homeNamespace: string,
): ServiceImpl<typeof AuthorizationService> {
  const home = clients.get(homeNamespace);
  if (!home) throw new Error("Home workspace authority missing");
  const options = (context: HandlerContext) => ({
    headers: credentialHeaders(context.requestHeader),
    signal: context.signal,
    timeoutMs: 10_000,
  });
  const target = (namespace: string) => {
    const client = clients.get(namespace);
    if (!client) throw new ConnectError("Workspace unavailable", Code.NotFound);
    return client;
  };
  const workspace = (value?: WorkspaceAuthorizationReference) => {
    if (!value?.namespace || !value.uid)
      throw new ConnectError("Workspace identity required", Code.InvalidArgument);
    return target(value.namespace);
  };
  async function listWorkspaces(request: ListWorkspacesRequest, context: HandlerContext) {
    if (request.workspace) {
      const result = await target(request.workspace.namespace).listWorkspaces(
        request,
        options(context),
      );
      if (
        result.workspaces.length > 1 ||
        result.workspaces.some(
          (item) =>
            item.namespace !== request.workspace?.namespace ||
            !item.uid ||
            (request.workspace?.uid && item.uid !== request.workspace.uid),
        )
      )
        throw new ConnectError("Invalid workspace directory response", Code.Unavailable);
      return result;
    }
    const found = await Promise.all(
      [...clients].map(async ([namespace, client]) => {
        const result = await client.listWorkspaces({ workspace: { namespace } }, options(context));
        if (
          result.workspaces.length > 1 ||
          result.workspaces.some((item) => item.namespace !== namespace || !item.uid)
        )
          throw new ConnectError("Invalid workspace directory response", Code.Unavailable);
        return result.workspaces[0];
      }),
    );
    const items = found
      .filter((item): item is WorkspaceAuthorizationReference => !!item)
      .sort((a, b) => a.namespace.localeCompare(b.namespace));
    const page = pageOf(
      items,
      { pageSize: request.page?.limit || 50, pageToken: request.page?.pageToken ?? "", query: "" },
      "authorization.workspaces",
      (item) => ({ id: item.namespace, time: 0 }),
    );
    return { workspaces: page.items, page: { nextPageToken: page.nextPageToken } };
  }
  return {
    listAccessRoles: (request, context) => home.listAccessRoles(request, options(context)),
    listWorkspaces,
    checkPermissions: (request, context) =>
      workspace(request.workspace).checkPermissions(request, options(context)),
    listRoleBindings: (request, context) =>
      workspace(request.workspace).listRoleBindings(request, options(context)),
    grantRole: (request, context) =>
      workspace(request.workspace).grantRole(request, options(context)),
    revokeRole: (request, context) =>
      workspace(request.workspace).revokeRole(request, options(context)),
  };
}
