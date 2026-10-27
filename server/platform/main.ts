import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { AuthenticationV1Api, CoreV1Api, KubeConfig } from "@kubernetes/client-node";
import Fastify, { LogController } from "fastify";
import { discovery } from "openid-client";
import { ExtMcp } from "../../gen/agentgateway/dev/ext_mcp/ext_mcp_pb.js";
import { registerDelegation } from "../authorization/delegation.js";
import { environmentCredentials, environmentTokens } from "../authorization/environment-tokens.js";
import { relatedExecutions } from "../authorization/executions.js";
import { actorKeyServer } from "../authorization/keys.js";
import { modelAuthorization } from "../authorization/models.js";
import { registerRuntime } from "../authorization/native.js";
import { oidcIdentity } from "../authorization/oidc.js";
import { platformToolAuthorization } from "../authorization/platform-tools.js";
import { executionRuntime } from "../authorization/runtime.js";
import { gatewayAuthorization } from "../authorization/transport.js";
import { workloadConfiguration, workloadIdentity } from "../authorization/workloads.js";
import { automationPresets } from "../automation/presets.js";
import { automationService } from "../automation/service.js";
import { registerConsole } from "../console/app.js";
import { loadPack } from "../console/pack.js";
import { consoleService } from "../console/service.js";
import { templateWriter } from "../console/template-writer.js";
import { toolBindings } from "../governance/bindings.js";
import { governanceConfig } from "../governance/config.js";
import { approvalCoordinator } from "../governance/coordinator.js";
import { coordinationQueue, startCoordination } from "../jobs/coordination.js";
import { kagentClients, kagentTransport } from "../kagent/clients.js";
import { configurationClients } from "../kagent/configuration.js";
import { toolMetadata } from "../kagent/tool-metadata.js";
import { knowledgeConfig } from "../knowledge/config.js";
import { knowledgeService } from "../knowledge/service.js";
import { resourceStore } from "../management/resources.js";
import { managementService } from "../management/service.js";
import { mcpApps } from "../mcp-apps/service.js";
import { taskProjection } from "../read-model/projection.js";
import { reconciler } from "../read-model/reconcile.js";
import { kagentConfig, listenConfig, requiredEnv, roleDefaults } from "../shared/config.js";
import { voiceCalls } from "../speech/calls.js";
import { speechService } from "../speech/service.js";
import { speechSettingsStore } from "../speech/store.js";
import { registerTranscription } from "../speech/transcription.js";
import { taskTagStore } from "../tasks/store.js";
import { continuations } from "../team-sessions/continuation.js";
import { workspaceContext } from "./access.js";
import { registerEnvironmentApis } from "./environment-api.js";
import { grpcServer } from "./grpc.js";
import { collaborationGuardrails } from "./guardrails.js";
import { registerPlatformMcp } from "./mcp.js";

const config = kagentConfig();
const issuer = requiredEnv("AGENTOS_OIDC_ISSUER");
const oauth = await discovery(
  new URL(issuer),
  requiredEnv("AGENTOS_OIDC_CLIENT_ID"),
  requiredEnv("AGENTOS_OIDC_CLIENT_SECRET"),
);
oauth.timeout = 10;
const identity = await oidcIdentity(
  {
    issuer,
    audience: requiredEnv("AGENTOS_OIDC_AUDIENCE"),
    writerRole: requiredEnv("AGENTOS_OIDC_WRITER_ROLE"),
  },
  oauth,
);
const origin = requiredEnv("AGENTOS_API_ORIGIN");
const packRoot = process.env.AGENTOS_PACK_DIR ? resolve(process.env.AGENTOS_PACK_DIR) : undefined;
const app = Fastify({
  logger: true,
  logController: new LogController({ disableRequestLogging: true }),
  bodyLimit: 2 * 1024 * 1024,
});
const clients = kagentClients(kagentTransport(config));
const database = {
  uri: requiredEnv("AGENTOS_EXECUTION_DATABASE_URL"),
  ca: process.env.AGENTOS_EXECUTION_DATABASE_CA
    ? readFileSync(process.env.AGENTOS_EXECUTION_DATABASE_CA, "utf8")
    : undefined,
};
const kubeConfig = new KubeConfig();
kubeConfig.loadFromDefault();
const configuration = await configurationClients(kubeConfig, config.namespace, clients, app.log);
const access = toolBindings(kubeConfig, config.namespace, undefined, configuration.backends);
const operations = governanceConfig();
const environmentToken = environmentTokens(
  operations,
  environmentCredentials(kubeConfig, config.namespace),
  process.env.AGENTOS_USER_TOKEN_EXCHANGE !== "false",
);

const metadata = toolMetadata(clients);
const execution = await executionRuntime(
  configuration.clients,
  config.namespace,
  access,
  identity,
  config.userId,
  environmentToken,
  oauth,
  metadata,
  app.log,
);
await registerDelegation(app, {
  origin,
  returnOrigins: JSON.parse(requiredEnv("AGENTOS_DELEGATION_ORIGINS")),
  client: oauth,
  key: Buffer.from(requiredEnv("AGENTOS_COOKIE_SECRET"), "base64"),
  grants: execution.background,
  executions: execution.registry,
});
registerEnvironmentApis(app, operations, environmentToken, identity);
const tags = await taskTagStore(database.uri, config.namespace, database.ca);
const projection = await taskProjection({
  ...database,
  workspace: config.namespace,
  clients,
  executions: execution.store,
});
const reconcile = reconciler(projection, clients, config.namespace, app.log);
const automation = automationPresets(config.namespace, packRoot);
const workloads = workloadIdentity(
  workloadConfiguration(),
  kubeConfig.makeApiClient(AuthenticationV1Api),
);
const knowledge = knowledgeConfig(config);
const speechSettings = speechSettingsStore(
  kubeConfig.makeApiClient(CoreV1Api),
  config.namespace,
  process.env.AGENTOS_SPEECH_SECRET ?? `${process.env.AGENTOS_RELEASE ?? "agentos"}-speech`,
);
const speech = speechService(
  speechSettings.load,
  voiceCalls(speechSettings.load, process.env.AGENTOS_VOICE_URL, process.env.AGENTOS_VOICE_TOKEN),
);
await registerTranscription(app, speechSettings.load, async (headers) => {
  await identity(headers);
});
const replaceTemplate = templateWriter(kubeConfig);
const pack = loadPack(packRoot),
  catalogName = process.env.AGENTOS_SKILL_CATALOG ?? "agentos-skills";
const store = resourceStore(kubeConfig, config.namespace, catalogName);
const gateway = {
  name: process.env.AGENTOS_GATEWAY_NAME ?? "agentos-gateway",
  url: process.env.AGENTOS_GATEWAY_URL ?? "http://agentos-gateway:8080",
  mcpUrl:
    process.env.AGENTOS_MCP_GATEWAY_URL ??
    process.env.AGENTOS_GATEWAY_URL ??
    "http://agentos-mcp-gateway:8080",
  namespace: config.namespace,
  secret: `${process.env.AGENTOS_RELEASE ?? "agentos"}-model-client`,
};
await registerConsole(app, {
  context: workspaceContext(
    config.namespace,
    process.env.AGENTOS_ENTRY_AGENT ?? "assistant",
    identity,
    execution.registry.remember,
  ),

  service: consoleService({
    metadata,
    apps: mcpApps({
      clients,
      projection,
      namespace: config.namespace,
      access,
      operations,
      metadata,
      sandboxOrigin: process.env.AGENTOS_SANDBOX_ORIGIN ?? "",
      token: environmentToken,
      log: app.log,
    }),
    projection,
    clients,
    namespace: config.namespace,
    access,
    operations,
    environmentToken,
    roleDefaults: roleDefaults(),
    replaceTemplate,
    pack,
    tags,
    speech,
    executions: execution.registry,
    entryAgent: process.env.AGENTOS_ENTRY_AGENT ?? "assistant",
    authorizeTools: execution.authorizeTools,
    delegationUrl: `${origin}/delegation/start`,
  }),
  management: managementService({
    clients,
    store,
    gateway,
    knowledge,
    speech: speechSettings,
  }),
  automation: automationService(
    clients,
    config.namespace,
    automation,
    operations.environments.flatMap((entry) => entry.environment?.name ?? []),
    process.env.AGENTOS_EVENT_AUTOMATION_ENABLED === "true",
    projection,
  ),
  ready: () => projection.healthy() && configuration.healthy(),
  packRoot,
});
await registerPlatformMcp(
  app,
  config,
  clients,
  projection,
  execution,
  workloads,
  access,
  knowledgeService(clients, knowledge),
  automation.scheduledRuns,
);
const continueDelegation = continuations(projection, async (contextId, contexts) => {
  const { session: parent } = await clients.sessions.getSession({ sessionId: contextId });
  if (!parent) throw new Error("Execution session is unavailable");
  await relatedExecutions(execution.registry, clients.sessions, parent, contexts);
});
const approvals = approvalCoordinator(
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
);
const jobs = await coordinationQueue(database.uri, config.namespace, app.log, database.ca);
// Coordination hooks join projection writes before the first reconciliation backfills them.
const stopCoordination = await startCoordination(projection, jobs, [continueDelegation, approvals]);
await reconcile.refresh();
const processor = grpcServer(app, {
  fallback: gatewayAuthorization(
    execution.authorizeTransport,
    modelAuthorization(configuration.clients, execution, workloads, config.namespace),
    workloads,
    { log: app.log },
  ),
  routes: (router) => {
    const collaboration = collaborationGuardrails(
      new Map([[config.namespace, clients]]),
      execution,
    );
    const platform = platformToolAuthorization(execution, workloads, access);
    router.service(ExtMcp, {
      async checkRequest(request, context) {
        if (request.metadataContext?.execution === true)
          return execution.guardrails.checkRequest(request, context);
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
    });
  },
});
const runtimeProcessor = grpcServer(app, {
  routes: (router) =>
    registerRuntime(router, execution, config, clients, knowledge.scope, projection.apply, app.log),
});
const keys = actorKeyServer(app, execution.actorKeys);
app.addHook("onClose", async () => {
  await stopCoordination();
  await jobs.boss.stop({ graceful: true, timeout: 40_000 });
  reconcile.close();
  await projection.close();
  await configuration.close();
  await execution.close();
  await tags.close();
});
reconcile.start();
await automation.seed(clients);
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => void app.close());
await Promise.all([
  processor.listen(Number(process.env.AGENTOS_GUARDRAILS_PORT ?? "9090"), listenConfig().host),
  runtimeProcessor.listen(Number(process.env.AGENTOS_RUNTIME_PORT ?? "9091"), listenConfig().host),
  keys.listen({ host: listenConfig().host, port: Number(process.env.AGENTOS_JWKS_PORT ?? "9092") }),
]);
await app.listen(listenConfig());
