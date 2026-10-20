import { create } from "@bufbuild/protobuf";
import { MethodOptions_IdempotencyLevel } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError, createContextKey, type Interceptor } from "@connectrpc/connect";
import { AccessProfileSchema } from "../../gen/agentos/console/v1/access_pb.js";
import type { jwtIdentity } from "../authorization/oidc.js";

export const accessProfile = createContextKey(create(AccessProfileSchema));

export function workspaceContext(
  workspace: string,
  entryAgent: string,
  identity?: ReturnType<typeof jwtIdentity>,
  origin = "",
): Interceptor {
  return (next) => async (request) => {
    const principal = identity
      ? await identity(request.header)
      : { subject: "console", write: true };
    if (request.method.idempotency !== MethodOptions_IdempotencyLevel.NO_SIDE_EFFECTS) {
      if (!principal.write) throw new ConnectError("Read-only access", Code.PermissionDenied);
      const source = request.header.get("origin");
      if (
        identity &&
        ((source && source !== origin) ||
          (!source && request.header.has("x-forwarded-access-token")))
      )
        throw new ConnectError("Request origin is invalid", Code.PermissionDenied);
    }
    request.contextValues.set(
      accessProfile,
      create(AccessProfileSchema, {
        workspace,
        subject: principal.subject,
        operate: principal.write,
        manage: principal.write,
        entryAgent: { namespace: workspace, name: entryAgent },
      }),
    );
    return next(request);
  };
}
