import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { ExecutionIdentitySchema } from "../../gen/agentos/execution/v1/identity_pb.js";
import type { Session } from "../../gen/kagent/api/v1/sessions_pb.js";
import type { KagentClients } from "../kagent/clients.js";
import { agentKey } from "../read-model/agents.js";

const scheduledExecutionId = (messageId: string) =>
  /^scheduled-run\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(
    messageId,
  )?.[1];

/** A message ID is only a hint; the native execution must attest this exact session and Agent. */
export function scheduledIdentity(clients: KagentClients, workspace: string, creator: string) {
  return async (candidate: Session, messageIds: string[] = []) => {
    if (candidate.agent?.namespace !== workspace) return;
    const options = { timeoutMs: 10_000 };
    const { session } = await clients.sessions.getSession({ sessionId: candidate.id }, options);
    if (
      !session ||
      session.creator !== creator ||
      agentKey(session.agent) !== agentKey(candidate.agent)
    )
      return;

    async function attest(ids: string[]) {
      for (const id of ids) {
        const executionId = scheduledExecutionId(id);
        if (!executionId) continue;
        const { execution } = await clients.schedules
          .getScheduledRunExecution({ executionId }, options)
          .catch((error: unknown) => {
            if (error instanceof ConnectError && error.code === Code.NotFound)
              return { execution: undefined };
            throw error;
          });
        if (!execution || execution.sessionId !== session?.id || execution.creator !== creator)
          continue;
        const { scheduledRun } = await clients.schedules.getScheduledRun(
          { scheduledRunId: execution.scheduledRunId },
          options,
        );
        if (
          !scheduledRun ||
          scheduledRun.creator !== creator ||
          agentKey(scheduledRun.agent) !== agentKey(session?.agent)
        )
          continue;
        return create(ExecutionIdentitySchema, {
          subject: `service:schedule:${workspace}:${scheduledRun.id}`,
          write: false,
          credential: { case: "service", value: true },
        });
      }
    }
    // Admission occurs before the runtime persists its first task. Only native
    // execution records, rather than caller-provided message contents, grant it.
    if (messageIds.length) return attest(messageIds);
    let pageToken = "";
    const seen = new Set<string>();
    for (;;) {
      if (seen.has(pageToken)) throw new ConnectError("Invalid upstream cursor", Code.Unavailable);
      seen.add(pageToken);
      const page = await clients.a2a.listTasks(
        {
          tenant: agentKey(session.agent),
          contextId: session.id,
          pageSize: 100,
          pageToken,
        },
        options,
      );
      const identity = await attest(
        page.tasks
          .filter((task) => task.contextId === session.id)
          .flatMap((task) => task.history.map((message) => message.messageId)),
      );
      if (identity) return identity;
      pageToken = page.nextPageToken;
      if (!pageToken) return;
    }
  };
}
