import { ApiException, CustomObjectsApi, type KubeConfig } from "@kubernetes/client-node";
import { TaskState } from "../../gen/a2a_pb.js";
import { RuntimeState } from "../../gen/kagent/api/v1/runtime_pb.js";
import { eachPage, type KagentClients } from "../kagent/clients.js";
import { agentKey } from "../read-model/agents.js";
import { variantPrefix } from "./names.js";
import type { evaluationSandboxes } from "./sandbox.js";

/** Revoke test identities and stop only native contexts belonging to this candidate. */
export function evaluationCleanup(
  config: KubeConfig,
  clients: KagentClients,
  sandboxes: ReturnType<typeof evaluationSandboxes>,
  namespace: string,
) {
  const custom = config.makeApiClient(CustomObjectsApi);
  return async (id: string) => {
    await sandboxes.keys.revoke(id);
    sandboxes.release(id);
    const prefixes = [variantPrefix(id, "candidate"), variantPrefix(id, "released")];
    await eachPage(
      async (pageToken) => {
        const page = await clients.sessions.listSessions(
          { page: { limit: 100, pageToken } },
          { timeoutMs: 15_000 },
        );
        for (const session of page.sessions) {
          if (
            session.agent?.namespace !== namespace ||
            !prefixes.some((prefix) => session.agent?.name.startsWith(prefix))
          )
            continue;
          const tenant = agentKey(session.agent);
          await eachPage(
            async (pageToken) => {
              const tasks = await clients.a2a.listTasks(
                { tenant, contextId: session.id, pageSize: 100, pageToken, historyLength: 0 },
                { timeoutMs: 15_000 },
              );
              for (const task of tasks.tasks)
                if (
                  ![
                    TaskState.COMPLETED,
                    TaskState.CANCELED,
                    TaskState.FAILED,
                    TaskState.REJECTED,
                  ].includes(task.status?.state ?? TaskState.UNSPECIFIED)
                )
                  await clients.a2a.cancelTask({ tenant, id: task.id }, { timeoutMs: 30_000 });
              return { items: [], token: tasks.nextPageToken };
            },
            () => {},
          );
          if (session.state !== RuntimeState.SUSPENDED && session.state !== RuntimeState.DELETED)
            await clients.sessions.suspendSession({ sessionId: session.id }, { timeoutMs: 60_000 });
        }
        return { items: [], token: page.page?.nextPageToken ?? "" };
      },
      () => {},
    );
    for (const prefix of prefixes)
      await custom
        .deleteNamespacedCustomObject({
          group: "gateway.networking.k8s.io",
          version: "v1",
          plural: "gateways",
          namespace,
          name: `${prefix}gateway`,
        })
        .catch((error: unknown) => {
          if (!(error instanceof ApiException && error.code === 404)) throw error;
        });
  };
}
