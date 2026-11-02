import type { DescService } from "@bufbuild/protobuf";
import { Code, ConnectError, type HandlerContext, type ServiceImpl } from "@connectrpc/connect";
import { requestWorkspace } from "./access.js";

/** Connect's service shape is generated from the descriptor; selected handlers keep streaming intact. */
export function workspaceService<S extends DescService>(
  descriptor: S,
  services: ReadonlyMap<string, ServiceImpl<S>>,
): ServiceImpl<S> {
  const handlers = Object.fromEntries(
    Object.keys(descriptor.method).map((name) => [
      name,
      (request: unknown, context: HandlerContext) => {
        const service = services.get(context.values.get(requestWorkspace));
        if (!service) throw new ConnectError("Workspace unavailable", Code.Unavailable);
        const handler = service[name as keyof typeof service] as (
          request: unknown,
          context: HandlerContext,
        ) => unknown;
        return handler(request, context);
      },
    ]),
  );
  return handlers as ServiceImpl<S>;
}
