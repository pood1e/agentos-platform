import { Code, ConnectError } from "@connectrpc/connect";
import type { WorkspaceAuthorizationReference } from "../../gen/kagent/api/v1/authorization_pb.js";
import type { KagentClients } from "../kagent/clients.js";
import { credentialHeaders } from "../kagent/context.js";

/** A native authority answers only for its own namespace; anything else means it is broken. */
export function directoryEntry(
  workspaces: WorkspaceAuthorizationReference[],
  namespace: string,
  uid = "",
) {
  if (
    workspaces.length > 1 ||
    workspaces.some(
      (item) => item.namespace !== namespace || !item.uid || (uid !== "" && item.uid !== uid),
    )
  )
    throw new ConnectError("Invalid workspace directory response", Code.Unavailable);
  return workspaces.at(0);
}

export type WorkspaceMember = (
  headers: Headers,
  signal: AbortSignal,
  uid: string,
) => Promise<WorkspaceAuthorizationReference>;

export function memberWorkspace(
  client: KagentClients["authorization"],
  namespace: string,
): WorkspaceMember {
  return async (headers, signal, uid) => {
    const { workspaces } = await client.listWorkspaces(
      { workspace: { namespace, uid } },
      { headers: credentialHeaders(headers), signal, timeoutMs: 10_000 },
    );
    const workspace = directoryEntry(workspaces, namespace, uid);
    if (!workspace) throw new ConnectError("Workspace access denied", Code.PermissionDenied);
    return workspace;
  };
}
