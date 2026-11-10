import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, createContextKey, type Interceptor } from "@connectrpc/connect";
import { UserIdentitySchema } from "../../gen/agentos/authorization/v1/identity_pb.js";
import { AccessProfileSchema } from "../../gen/agentos/console/v1/access_pb.js";
import { AuthorizationService } from "../../gen/kagent/api/v1/authorization_pb.js";
import type { userIdentity } from "../authorization/identity.js";
import { mayCall } from "../authorization/permissions.js";
import type { WorkspaceMember } from "../authorization/workspaces.js";
import { nativeHeaders, nativeRequestHeaders, nativeStream } from "../kagent/context.js";

export const accessProfile = createContextKey(create(AccessProfileSchema));
export const requestIdentity = createContextKey(create(UserIdentitySchema));
export const requestWorkspace = createContextKey("");

type Identity = ReturnType<typeof userIdentity>;

/**
 * Every request carries a bearer token; browser sessions belong to the console in front.
 * AuthorizationService selects its native authority per request, so it needs only a principal.
 */
export function workspaceContext(
  homeIdentity: Identity,
  targets: ReadonlyMap<string, { entryAgent: string; identity: Identity; member: WorkspaceMember }>,
): Interceptor {
  return (next) => async (request) => {
    const headers = nativeRequestHeaders(request.header);
    await nativeHeaders.run(headers, async () => {
      if (request.service.typeName === AuthorizationService.typeName) {
        request.contextValues.set(requestIdentity, await homeIdentity(headers));
        return;
      }
      const namespace = request.header.get("x-agentos-workspace");
      const uid = request.header.get("x-agentos-workspace-uid");
      const target = namespace ? targets.get(namespace) : undefined;
      if (!target || !uid)
        throw new ConnectError("Workspace selection required", Code.InvalidArgument);
      const principal = await target.identity(headers);
      const workspace = await target.member(headers, request.signal, uid);
      if (!mayCall(principal, request.method, request.message))
        throw new ConnectError("Permission denied", Code.PermissionDenied);
      request.contextValues.set(requestIdentity, principal);
      request.contextValues.set(requestWorkspace, workspace.namespace);
      request.contextValues.set(
        accessProfile,
        create(AccessProfileSchema, {
          workspace,
          subject: principal.subject,
          capabilities: principal.capabilities,
          write: principal.write,
          entryAgent: { namespace: workspace.namespace, name: target.entryAgent },
        }),
      );
    });
    const response = await nativeHeaders.run(headers, () => next(request));
    return response.stream
      ? { ...response, message: nativeStream(response.message, headers) }
      : response;
  };
}
