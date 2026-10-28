import { Code, ConnectError } from "@connectrpc/connect";
import type { UserIdentity } from "../../gen/agentos/authorization/v1/identity_pb.js";
import type { DeleteSessionRequest } from "../../gen/kagent/api/v1/sessions_pb.js";
import type { KagentClients } from "../kagent/clients.js";
import { notFound, precondition } from "../shared/errors.js";
import { chatTarget } from "./history.js";

export function conversationCommands(
  clients: KagentClients,
  namespace: string,
  entryAgent: string,
) {
  return {
    async remove(request: DeleteSessionRequest, identity: UserIdentity) {
      const { session } = await clients.sessions.getSession(
        { sessionId: request.sessionId },
        { timeoutMs: 5_000 },
      );
      if (!session) throw notFound("chat.invalidConversation");
      chatTarget(namespace, entryAgent, session.agent, identity);
      try {
        return await clients.sessions.deleteSession(request, { timeoutMs: 30_000 });
      } catch (error) {
        if (
          error instanceof ConnectError &&
          [Code.Aborted, Code.FailedPrecondition].includes(error.code)
        )
          throw precondition("chat.deleteBusy");
        throw error;
      }
    },
  };
}
