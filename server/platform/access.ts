import { create } from "@bufbuild/protobuf";
import { MethodOptions_IdempotencyLevel } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError, createContextKey, type Interceptor } from "@connectrpc/connect";
import { AccessProfileSchema } from "../../gen/agentos/console/v1/access_pb.js";
import {
  type ExecutionIdentity,
  ExecutionIdentitySchema,
} from "../../gen/agentos/execution/v1/identity_pb.js";
import { can } from "../../shared/permissions.js";
import type { jwtIdentity } from "../authorization/oidc.js";
import { requiredCapability } from "../authorization/permissions.js";

export const accessProfile = createContextKey(create(AccessProfileSchema));
export const requestIdentity = createContextKey(create(ExecutionIdentitySchema));

const selfServiceMethods = new Set([
  "SendMessage",
  "CallAppTool",
  "DeleteSession",
  "RespondInteraction",
  "CancelTask",
  "UpdateTaskTags",
  "TranscribeAudio",
  "SynthesizeSpeech",
  "StartVoiceCall",
  "EndVoiceCall",
]);

/** Every request carries a bearer token; browser sessions belong to the console in front. */
export function workspaceContext(
  workspace: string,
  entryAgent: string,
  identity: ReturnType<typeof jwtIdentity>,
  remember?: (identity: ExecutionIdentity) => Promise<ExecutionIdentity>,
): Interceptor {
  return (next) => async (request) => {
    let principal = await identity(request.header);
    principal = (await remember?.(principal)) ?? principal;
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
    return next(request);
  };
}
