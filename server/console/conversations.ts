import { Code, ConnectError } from "@connectrpc/connect";
import type { ExecutionIdentity } from "../../gen/agentos/execution/v1/identity_pb.js";
import { ActivityState } from "../../gen/agentos/execution/v1/state_pb.js";
import type {
  DeleteSessionRequest,
  DeleteSessionResponse,
} from "../../gen/kagent/api/v1/sessions_pb.js";
import type { Executions } from "../authorization/executions.js";
import type { KagentClients } from "../kagent/clients.js";
import type { TaskQueries } from "../read-model/queries.js";
import { awaiting } from "../read-model/state.js";
import { conversationProgress } from "../read-model/views/conversation-work.js";
import { notFound, precondition } from "../shared/errors.js";
import { chatTarget } from "./history.js";

export function conversationCommands(
  projection: TaskQueries,
  clients: KagentClients,
  namespace: string,
  entryAgent: string,
  executions: Executions,
) {
  /** Conversation state after re-reading every session of its execution tree natively. */
  async function progress(sessionId: string) {
    const graph = await projection.graphOf({ contextId: sessionId });
    return graph ? conversationProgress(graph, sessionId).state : ActivityState.IDLE;
  }

  return {
    remove: (request: DeleteSessionRequest, identity: ExecutionIdentity) =>
      projection.exclusive(request.sessionId, async () => {
        const { session } = await clients.sessions.getSession(
          { sessionId: request.sessionId },
          { timeoutMs: 5_000 },
        );
        if (!session) throw notFound("chat.invalidConversation");
        chatTarget(namespace, entryAgent, session.agent, identity);
        try {
          const { binding } = await executions.record(session, true);
          if (binding.subject !== identity.subject) throw new Error("Foreign conversation");
        } catch {
          throw notFound("chat.invalidConversation");
        }
        const state = await progress(session.id);
        if (awaiting(state) || state === ActivityState.WORKING || state === ActivityState.SUBMITTED)
          throw precondition("chat.deleteBusy");
        let result: DeleteSessionResponse;
        try {
          result = await clients.sessions.deleteSession(request, { timeoutMs: 30_000 });
        } catch (error) {
          if (
            error instanceof ConnectError &&
            (error.code === Code.Aborted || error.code === Code.FailedPrecondition)
          )
            throw precondition("chat.deleteBusy");
          throw error;
        }
        await executions.revoke(session, identity);
        return result;
      }),
  };
}
