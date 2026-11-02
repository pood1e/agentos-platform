import { Code, ConnectError } from "@connectrpc/connect";
import type { UserIdentity } from "../../gen/agentos/authorization/v1/identity_pb.js";
import type { DeleteSessionRequest } from "../../gen/kagent/api/v1/sessions_pb.js";
import type { KagentClients } from "../kagent/clients.js";
import { agentRef } from "../read-model/agents.js";
import type { TaskQueries } from "../read-model/queries.js";
import { notFound, precondition } from "../shared/errors.js";
import { chatTarget } from "./history.js";

export function conversationCommands(
  projection: Pick<TaskQueries, "session">,
  clients: KagentClients,
  namespace: string,
  entryAgent: string,
) {
  return {
    async remove(request: DeleteSessionRequest, identity: UserIdentity) {
      const session = await projection.session(request.sessionId);
      if (!session) throw notFound("chat.invalidConversation");
      chatTarget(namespace, entryAgent, agentRef(session.agentId), identity);
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
