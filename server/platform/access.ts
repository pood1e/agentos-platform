import { create } from "@bufbuild/protobuf";
import { MethodOptions_IdempotencyLevel } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError, createContextKey, type Interceptor } from "@connectrpc/connect";
import { AccessProfileSchema } from "../../gen/agentos/console/v1/access_pb.js";
import {
  type ExecutionIdentity,
  ExecutionIdentitySchema,
} from "../../gen/agentos/execution/v1/identity_pb.js";
import type { jwtIdentity } from "../authorization/oidc.js";

export const accessProfile = createContextKey(create(AccessProfileSchema));
export const requestIdentity = createContextKey(create(ExecutionIdentitySchema));

const executionMethods = new Set(["SendMessage", "RespondInteraction", "CancelTask"]);

export function workspaceContext(
  workspace: string,
  entryAgent: string,
  identity?: ReturnType<typeof jwtIdentity>,
  origin = "",
  remember?: (identity: ExecutionIdentity) => Promise<ExecutionIdentity>,
): Interceptor {
  return (next) => async (request) => {
    let principal = identity
      ? await identity(request.header)
      : create(ExecutionIdentitySchema, {
          subject: "console",
          write: true,
          credential: { case: "service", value: true },
        });
    principal = (await remember?.(principal)) ?? principal;
    if (request.method.idempotency !== MethodOptions_IdempotencyLevel.NO_SIDE_EFFECTS) {
      if (
        !principal.write &&
        !(
          request.service.typeName === "agentos.console.v1.ConsoleService" &&
          executionMethods.has(request.method.name)
        )
      )
        throw new ConnectError("Read-only access", Code.PermissionDenied);
      const source = request.header.get("origin");
      if (
        identity &&
        ((source && source !== origin) ||
          (!source && request.header.has("x-forwarded-access-token")))
      )
        throw new ConnectError("Request origin is invalid", Code.PermissionDenied);
    }
    request.contextValues.set(requestIdentity, principal);
    request.contextValues.set(
      accessProfile,
      create(AccessProfileSchema, {
        workspace,
        subject: principal.subject,
        operate: true,
        manage: principal.write,
        entryAgent: { namespace: workspace, name: entryAgent },
      }),
    );
    return next(request);
  };
}
