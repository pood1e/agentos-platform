import { create } from "@bufbuild/protobuf";
import { MethodOptions_IdempotencyLevel } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError, createContextKey, type Interceptor } from "@connectrpc/connect";
import { UserIdentitySchema } from "../../gen/agentos/authorization/v1/identity_pb.js";
import { AccessProfileSchema } from "../../gen/agentos/console/v1/access_pb.js";
import { can } from "../../shared/permissions.js";
import type { userIdentity } from "../authorization/identity.js";
import { requiredCapability } from "../authorization/permissions.js";
import { nativeHeaders, nativeRequestHeaders, nativeStream } from "../kagent/context.js";

export const accessProfile = createContextKey(create(AccessProfileSchema));
export const requestIdentity = createContextKey(create(UserIdentitySchema));

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
  workspace: string,
  entryAgent: string,
  identity: ReturnType<typeof userIdentity>,
): Interceptor {
  return (next) => async (request) => {
    const headers = nativeRequestHeaders(request.header);
    const principal = await nativeHeaders.run(headers, () => identity(headers));
    if (
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
    request.contextValues.set(
      accessProfile,
      create(AccessProfileSchema, {
        workspace,
        subject: principal.subject,
        capabilities: principal.capabilities,
        write: principal.write,
        entryAgent: { namespace: workspace, name: entryAgent },
      }),
    );
    const response = await nativeHeaders.run(headers, () => next(request));
    return response.stream
      ? { ...response, message: nativeStream(response.message, headers) }
      : response;
  };
}
