import { create } from "@bufbuild/protobuf";
import { createContextKey, type Interceptor } from "@connectrpc/connect";
import { AccessProfileSchema } from "../../gen/agentos/console/v1/access_pb.js";

export const accessProfile = createContextKey(create(AccessProfileSchema));

export function workspaceContext(workspace: string, entryAgent = "assistant"): Interceptor {
  return (next) => async (request) => {
    request.contextValues.set(
      accessProfile,
      create(AccessProfileSchema, {
        workspace,
        subject: "console",
        operate: true,
        manage: true,
        entryAgent: { namespace: workspace, name: entryAgent },
      }),
    );
    return next(request);
  };
}
