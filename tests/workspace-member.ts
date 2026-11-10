import { create } from "@bufbuild/protobuf";
import type { Interceptor } from "@connectrpc/connect";
import { WorkspaceAuthorizationReferenceSchema } from "../gen/kagent/api/v1/authorization_pb.js";
import type { userIdentity } from "../server/authorization/identity.js";
import type { WorkspaceMember } from "../server/authorization/workspaces.js";
import { workspaceContext } from "../server/platform/access.js";

export const allowWorkspace = (namespace: string) => async () =>
  create(WorkspaceAuthorizationReferenceSchema, { namespace, uid: `${namespace}-uid` });

export function testWorkspaceContext(
  namespace: string,
  identity: ReturnType<typeof userIdentity>,
  member: WorkspaceMember,
  uid = `${namespace}-uid`,
): Interceptor {
  const context = workspaceContext(
    identity,
    new Map([[namespace, { entryAgent: "assistant", identity, member }]]),
  );
  return (next) => {
    const handler = context(next);
    return (request) => {
      request.header.set("x-agentos-workspace", namespace);
      request.header.set("x-agentos-workspace-uid", uid);
      return handler(request);
    };
  };
}
