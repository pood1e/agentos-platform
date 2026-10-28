import { relatedExecutions } from "../authorization/executions.js";
import { approvalCoordinator } from "../governance/coordinator.js";
import { consumeCoordination, enqueueCoordination } from "../jobs/coordination.js";
import { reconciler } from "../read-model/reconcile.js";
import { listenConfig } from "../shared/config.js";
import { registerHealth } from "../shared/health.js";
import { advisoryLease } from "../shared/lease.js";
import { continuations } from "../team-sessions/continuation.js";
import {
  closeOnSignal,
  executionServices,
  platformApp,
  platformClients,
  platformConfig,
  projectionServices,
} from "./platform.js";

const config = platformConfig();
const { workspace } = config;
const app = platformApp();
const clients = platformClients(config);
const { access, operations, environmentToken, execution } = await executionServices(
  config,
  clients,
  app.log,
);
const { projection, jobs } = await projectionServices(
  config,
  clients,
  execution.store,
  app.log,
  true,
);
const coordinators = [
  continuations(projection, async (contextId, contexts) => {
    const { session: parent } = await clients.sessions.getSession({ sessionId: contextId });
    if (!parent) throw new Error("Execution session is unavailable");
    await relatedExecutions(execution.registry, clients.sessions, parent, contexts);
  }),
  approvalCoordinator(
    projection,
    operations,
    async (contextId, tools) => {
      const { session } = await clients.sessions.getSession(
        { sessionId: contextId },
        { timeoutMs: 5_000 },
      );
      if (!session) throw new Error("Execution session is unavailable");
      await execution.authorizeTools(session, tools);
    },
    environmentToken,
  ),
];
// The worker's own reconciliation writes enqueue coordination like every other writer.
enqueueCoordination(projection, jobs, coordinators);
const stopCoordination = await consumeCoordination(jobs, coordinators);

const reconcile = reconciler(projection, clients, workspace, app.log);
const lease = advisoryLease(config.database, `agentos_reconcile:${workspace}`);
reconcile.start(lease.held);

registerHealth(app, () => projection.reachable());
closeOnSignal(app, [
  reconcile.close,
  lease.release,
  stopCoordination,
  () => jobs.boss.stop({ graceful: true, timeout: 40_000 }),
  projection.close,
  access.close,
  execution.close,
]);
await app.listen(listenConfig());
