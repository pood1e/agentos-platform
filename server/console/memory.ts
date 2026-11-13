import { Code, ConnectError, type HandlerContext, type ServiceImpl } from "@connectrpc/connect";
import type { MemoryService } from "../../gen/kagent/runtime/v1/memory_pb.js";
import type { KagentClients } from "../kagent/clients.js";

/**
 * Agent memory is the team knowledge an Agent accumulates. Listing and curating it go to
 * the workspace's native authority with the caller's credentials, which authorizes each
 * request against the Agent; Agents of other workspaces stay out of this route.
 */
export function agentMemory(
  client: KagentClients["memory"],
  namespace: string,
): Pick<ServiceImpl<typeof MemoryService>, "list" | "deleteEntry"> {
  const inWorkspace = (agentName: string) => {
    if (!agentName.startsWith(`${namespace}/`))
      throw new ConnectError("Agent memory unavailable", Code.NotFound);
  };
  const options = (context: HandlerContext) => ({ signal: context.signal, timeoutMs: 10_000 });
  return {
    list(request, context) {
      inWorkspace(request.agentName);
      return client.list(request, options(context));
    },
    deleteEntry(request, context) {
      inWorkspace(request.agentName);
      return client.deleteEntry(request, options(context));
    },
  };
}
