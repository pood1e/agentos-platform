import { create } from "@bufbuild/protobuf";
import { MethodOptions_IdempotencyLevel } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError, createContextKey, type Interceptor } from "@connectrpc/connect";
import { UserIdentitySchema } from "../../gen/agentos/authorization/v1/identity_pb.js";
import { AccessProfileSchema } from "../../gen/agentos/console/v1/access_pb.js";
import {
  AuthorizationService,
  type WorkspaceAuthorizationReference,
} from "../../gen/kagent/api/v1/authorization_pb.js";
import { can } from "../../shared/permissions.js";
import type { userIdentity } from "../authorization/identity.js";
import { requiredCapability } from "../authorization/permissions.js";
import type { KagentClients } from "../kagent/clients.js";
import {
  credentialHeaders,
  nativeHeaders,
  nativeRequestHeaders,
  nativeStream,
} from "../kagent/context.js";

export const accessProfile = createContextKey(create(AccessProfileSchema));
export const requestIdentity = createContextKey(create(UserIdentitySchema));
export const requestWorkspace = createContextKey("");

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
    if (!workspaces.length)
      throw new ConnectError("Workspace access denied", Code.PermissionDenied);
    const workspace = workspaces[0];
    if (
      workspaces.length !== 1 ||
      workspace.namespace !== namespace ||
      !workspace.uid ||
      (uid && workspace.uid !== uid)
    )
      throw new ConnectError("Invalid workspace directory response", Code.Unavailable);
    return workspace;
  };
}

const selfServiceMethods = new Set([
  "SendMessage",
  "CallAppTool",
  "DeleteSession",
  "RespondInteraction",
  "CancelTask",
  "StartVoiceSession",
]);

/** Every request carries a bearer token; browser sessions belong to the console in front. */
export function workspaceContext(
  homeIdentity: ReturnType<typeof userIdentity>,
  targets: ReadonlyMap<
    string,
    { entryAgent: string; identity: ReturnType<typeof userIdentity>; member: WorkspaceMember }
  >,
): Interceptor {
  return (next) => async (request) => {
    const headers = nativeRequestHeaders(request.header);
    const isAuthorization = request.service.typeName === AuthorizationService.typeName;
    const namespace = request.header.get("x-agentos-workspace");
    const uid = request.header.get("x-agentos-workspace-uid");
    const target = namespace ? targets.get(namespace) : undefined;
    if (!isAuthorization && (!target || !uid))
      throw new ConnectError("Workspace selection required", Code.InvalidArgument);
    const principal = await nativeHeaders.run(headers, () =>
      (isAuthorization ? homeIdentity : (target?.identity ?? homeIdentity))(headers),
    );
    const workspace =
      target && uid && !isAuthorization
        ? await nativeHeaders.run(headers, () => target.member(headers, request.signal, uid))
        : undefined;
    if (
      !isAuthorization &&
      request.method.idempotency !== MethodOptions_IdempotencyLevel.NO_SIDE_EFFECTS &&
      !(
        request.service.typeName === "agentos.console.v1.ConsoleService" &&
        selfServiceMethods.has(request.method.name)
      )
    ) {
      const capability = requiredCapability(request.method, request.message);
      if (!capability || !can(principal, capability))
        throw new ConnectError("Permission denied", Code.PermissionDenied);
    }
    request.contextValues.set(requestIdentity, principal);
    if (workspace && target) {
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
    }
    const response = await nativeHeaders.run(headers, () => next(request));
    return response.stream
      ? { ...response, message: nativeStream(response.message, headers) }
      : response;
  };
}
