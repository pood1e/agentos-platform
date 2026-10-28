import { AuthenticationV1Api } from "@kubernetes/client-node";
import { ExtMcp } from "../../gen/agentgateway/dev/ext_mcp/ext_mcp_pb.js";
import { actorKeyServer } from "../authorization/keys.js";
import { modelAuthorization } from "../authorization/models.js";
import { registerRuntime } from "../authorization/native.js";
import { platformToolAuthorization } from "../authorization/platform-tools.js";
import { executionRuntime } from "../authorization/runtime.js";
import { gatewayAuthorization } from "../authorization/transport.js";
import { workloadConfiguration, workloadIdentity } from "../authorization/workloads.js";
import { approvalJobs } from "../governance/coordinator.js";
import { enqueueCoordination } from "../jobs/coordination.js";
import { configurationClients } from "../kagent/configuration.js";
import { knowledgeConfig } from "../knowledge/config.js";
import { knowledgeService } from "../knowledge/service.js";
import { grpcServer } from "../platform/grpc.js";
import { collaborationGuardrails } from "../platform/guardrails.js";
import { registerPlatformMcp } from "../platform/mcp.js";
import { listenConfig } from "../shared/config.js";
import { registerHealth } from "../shared/health.js";
import { rpcMetrics } from "../shared/telemetry.js";
import { continuationJobs } from "../team-sessions/continuation.js";
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
const configuration = await configurationClients(config.kube, workspace, clients, app.log);
const { access, operations, environmentToken, metadata, execution } = await executionServices(
  config,
  configuration.clients,
  app.log,
);
const { projection, jobs } = await projectionServices(config, clients, execution.store, app.log);
enqueueCoordination(projection, jobs, [continuationJobs, approvalJobs(operations)]);
const runtime = executionRuntime(
  execution,
  configuration.clients,
  workspace,
  access,
  environmentToken,
  metadata,
  app.log,
);
const workloads = workloadIdentity(
  workloadConfiguration(),
  config.kube.makeApiClient(AuthenticationV1Api),
);
const knowledge = knowledgeConfig(config.kagent);
await registerPlatformMcp(
  app,
  config.kagent,
  clients,
  projection,
  runtime,
  workloads,
  access,
  knowledgeService(clients, knowledge),
);
const collaboration = collaborationGuardrails(new Map([[workspace, clients]]), runtime);
const platform = platformToolAuthorization(runtime, workloads, access);
const guardrails = grpcServer(app, {
  interceptors: [rpcMetrics("server")],
  fallback: gatewayAuthorization(
    runtime.authorizeTransport,
    modelAuthorization(configuration.clients, runtime, workloads, workspace),
    workloads,
    { log: app.log },
  ),
  routes: (router) =>
    router.service(ExtMcp, {
      async checkRequest(request, context) {
        if (request.metadataContext?.execution === true)
          return runtime.guardrails.checkRequest(request, context);
        const result = await platform.checkRequest(request, context);
        if (
          result.result?.case !== "pass" ||
          request.metadataContext?.platformService !== "kagent-collaboration"
        )
          return result;
        return collaboration.checkRequest(request, context);
      },
      checkResponse(request, context) {
        return request.metadataContext?.platformService === "kagent-collaboration"
          ? collaboration.checkResponse(request, context)
          : platform.checkResponse(request, context);
      },
    }),
});
const persistence = grpcServer(app, {
  interceptors: [rpcMetrics("server")],
  routes: (router) =>
    registerRuntime(
      router,
      runtime,
      config.kagent,
      clients,
      knowledge.scope,
      projection.apply,
      app.log,
    ),
});
const keys = actorKeyServer(app, runtime.actorKeys);
registerHealth(
  app,
  async () => configuration.healthy() && access.healthy() && (await projection.reachable()),
);
closeOnSignal(app, [
  () => jobs.boss.stop({ graceful: true, timeout: 10_000 }),
  projection.close,
  configuration.close,
  access.close,
  execution.close,
]);
const { host } = listenConfig();
await Promise.all([
  guardrails.listen(Number(process.env.AGENTOS_GUARDRAILS_PORT ?? "9090"), host),
  persistence.listen(Number(process.env.AGENTOS_RUNTIME_PORT ?? "9091"), host),
  keys.listen({ host, port: Number(process.env.AGENTOS_JWKS_PORT ?? "9092") }),
]);
await app.listen(listenConfig());
