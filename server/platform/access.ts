import { create } from "@bufbuild/protobuf";
import { createContextKey, type Interceptor } from "@connectrpc/connect";
import { AccessProfileSchema } from "../../gen/agentos/console/v1/access_pb.js";

export const accessProfile = createContextKey(create(AccessProfileSchema));

export function workspaceContext(workspace: string): Interceptor {
  return (next) => async (request) => {
    request.contextValues.set(
      accessProfile,
      create(AccessProfileSchema, { workspace, subject: "console", operate: true, manage: true }),
    );
    return next(request);
  };
}
