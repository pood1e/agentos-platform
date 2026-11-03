import { Code, ConnectError, type HandlerContext, type ServiceImpl } from "@connectrpc/connect";
import type {
  AuthorizationService,
  ListWorkspacesRequest,
  WorkspaceAuthorizationReference,
} from "../../gen/kagent/api/v1/authorization_pb.js";
import type { KagentClients } from "../kagent/clients.js";
import { credentialHeaders } from "../kagent/context.js";
import { pageOf } from "../shared/page.js";
import { directoryEntry } from "./workspaces.js";

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
      const { namespace, uid } = request.workspace;
      const result = await target(namespace).listWorkspaces(request, options(context));
      directoryEntry(result.workspaces, namespace, uid);
      return result;
    }
    const found = await Promise.all(
      [...clients].map(async ([namespace, client]) => {
        const result = await client.listWorkspaces({ workspace: { namespace } }, options(context));
        return directoryEntry(result.workspaces, namespace);
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
