import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { create } from "@bufbuild/protobuf";
import { CoreV1Api, KubeConfig } from "@kubernetes/client-node";
import Fastify, { LogController } from "fastify";
import { discovery } from "openid-client";
import { ExtMcp } from "../../gen/agentgateway/dev/ext_mcp/ext_mcp_pb.js";
import { Capability } from "../../gen/agentos/authorization/v1/permission_pb.js";
import { ExecutionIdentitySchema } from "../../gen/agentos/execution/v1/identity_pb.js";
import { loadCatalog } from "../../shared/tool-catalog.js";
import { registerBrowserIdentity } from "../authorization/browser.js";
import { scopedCollaboration } from "../authorization/context.js";
import { environmentCredentials, environmentTokens } from "../authorization/environment-tokens.js";
import { relatedExecutions } from "../authorization/executions.js";
import { discoveryMethods } from "../authorization/mcp.js";
import { registerRuntime } from "../authorization/native.js";
import { oidcIdentity } from "../authorization/oidc.js";
import { executionRuntime } from "../authorization/runtime.js";
import { environmentAuthorization } from "../authorization/transport.js";
import { automationPresets } from "../automation/presets.js";
import { automationService } from "../automation/service.js";
import { registerConsole } from "../console/app.js";
import { loadPack } from "../console/pack.js";
import { roleCommands } from "../console/roles.js";
import { consoleService } from "../console/service.js";
import { templateWriter } from "../console/template-writer.js";
import { toolBindings } from "../governance/bindings.js";
import { governanceConfig } from "../governance/config.js";
import { approvalCoordinator } from "../governance/coordinator.js";
import { coordinationQueue, startCoordination } from "../jobs/coordination.js";
import { kagentClients, kagentTransport } from "../kagent/clients.js";
import { nativeInvocation } from "../kagent/invoke-session.js";
import { knowledgeConfig } from "../knowledge/config.js";
import { knowledgeService } from "../knowledge/service.js";
import { resourceStore } from "../management/resources.js";
import { managementService } from "../management/service.js";
import { TaskIndex } from "../read-model/index.js";
import { KagentSync } from "../read-model/sync.js";
import { kagentConfig, listenConfig, roleDefaults } from "../shared/config.js";
import { voiceCalls } from "../speech/calls.js";
import { speechService } from "../speech/service.js";
import { speechSettingsStore } from "../speech/store.js";
import { registerTranscription } from "../speech/transcription.js";
import { taskTagStore } from "../tasks/store.js";
import { registerTeamSessions } from "../team-sessions/app.js";
import { continuations } from "../team-sessions/continuation.js";
import { sessionTools } from "../team-sessions/tools.js";
import { workspaceContext } from "./access.js";
import { automationTools } from "./automation.js";
import { grpcServer } from "./grpc.js";
import { collaborationGuardrails } from "./guardrails.js";
import { machineIdentities } from "./machine-identities.js";

const config = kagentConfig();
const authentication = process.env.AGENTOS_AUTH_MODE ?? "none";
if (!["none", "oidc"].includes(authentication)) throw new Error("Unknown authentication mode");
const oauth =
  authentication === "oidc"
    ? await discovery(
        new URL(process.env.AGENTOS_OIDC_ISSUER ?? ""),
        process.env.AGENTOS_OIDC_CLIENT_ID ?? "",
        process.env.AGENTOS_OIDC_CLIENT_SECRET ?? "",
      )
    : undefined;
if (oauth) oauth.timeout = 10;
const identity =
  authentication === "oidc"
    ? await oidcIdentity(
        {
          issuer: process.env.AGENTOS_OIDC_ISSUER ?? "",
          audience: process.env.AGENTOS_OIDC_AUDIENCE ?? "",
          writerRole: process.env.AGENTOS_OIDC_WRITER_ROLE ?? "",
          origin: process.env.AGENTOS_ORIGIN ?? "",
        },
        oauth,
      )
    : undefined;
const token = process.env.AGENTOS_MCP_TOKEN;
if (!token) throw new Error("AGENTOS_MCP_TOKEN is required");
const packRoot = process.env.AGENTOS_PACK_DIR ? resolve(process.env.AGENTOS_PACK_DIR) : undefined;
const app = Fastify({
  logger: true,
  logController: new LogController({ disableRequestLogging: true }),
  bodyLimit: 2 * 1024 * 1024,
});
const clients = kagentClients(kagentTransport(config));
const sync = new KagentSync(clients, config.namespace, new TaskIndex(), app.log);
const kubeConfig = new KubeConfig();
kubeConfig.loadFromDefault();
const access = toolBindings(kubeConfig, config.namespace);
const operations = governanceConfig();
const environmentToken = environmentTokens(
  operations,
  environmentCredentials(kubeConfig, config.namespace),
);
const execution = await executionRuntime(
  clients,
  config.namespace,
  access,
  identity,
  config.userId,
  environmentToken,
  oauth,
);
if (oauth && execution.background)
  await registerBrowserIdentity(app, {
    origin: process.env.AGENTOS_ORIGIN ?? "",
    client: oauth,
    key: Buffer.from(process.env.AGENTOS_COOKIE_SECRET ?? "", "base64"),
    grants: execution.background,
    executions: execution.registry,
  });
const tags = await taskTagStore(
  process.env.AGENTOS_EXECUTION_DATABASE_URL ?? "",
  config.namespace,
  process.env.AGENTOS_EXECUTION_DATABASE_CA
    ? readFileSync(process.env.AGENTOS_EXECUTION_DATABASE_CA, "utf8")
    : undefined,
);
const automation = automationPresets(config.namespace, packRoot);
const catalog = loadCatalog();
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
  const origin = process.env.AGENTOS_ORIGIN;
  if (origin && headers.get("origin") !== origin) throw new Error("Invalid origin");
  if (identity) await identity(headers);
});
const replaceTemplate = templateWriter(kubeConfig);
const identities = machineIdentities(
  kubeConfig,
  config.namespace,
  process.env.AGENTOS_RELEASE ?? "agentos",
);
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
  secret: process.env.AGENTOS_GATEWAY_SECRET ?? "agentos-gateway",
};
function services(
  native = clients,
  resources = store,
  replace = replaceTemplate,
  bind = identities.bind,
) {
  return {
    service: consoleService({
      sync,
      clients: native,
      namespace: config.namespace,
      access,
      operations,
      environmentToken,
      roleDefaults: roleDefaults(),
      replaceTemplate: replace,
      pack,
      tags,
      speech,
      platformTools: bind,
      executions: execution.registry,
      entryAgent: process.env.AGENTOS_ENTRY_AGENT ?? "assistant",
      authorizeTools: execution.authorizeTools,
    }),
    management: managementService({
      clients: native,
      store: resources,
      gateway,
      knowledge,
      speech: speechSettings,
    }),
  };
}
const { alignRoles } = roleCommands(
  clients,
  config.namespace,
  access,
  roleDefaults(),
  replaceTemplate,
  identities.bind,
);
await registerConsole(app, {
  context: workspaceContext(
    config.namespace,
    process.env.AGENTOS_ENTRY_AGENT ?? "assistant",
    identity,
    process.env.AGENTOS_ORIGIN ?? "",
    execution.registry.remember,
  ),
  ...services(),
  automation: automationService(
    clients,
    config.namespace,
    automation,
    operations.environments.flatMap((entry) => entry.environment?.name ?? []),
    process.env.AGENTOS_EVENT_AUTOMATION_ENABLED === "true",
  ),
  ready: sync.healthy,
  staticRoot: resolve(process.env.AGENTOS_STATIC_ROOT ?? "dist"),
  packRoot,
});
await registerTeamSessions(
  app,
  sessionTools(clients, config.namespace, access, knowledgeService(clients, knowledge)),
  token,
  async (role, headers, method, tool) => {
    if (role === "automation") {
      const environment = headers["x-agentos-environment"];
      if (
        typeof environment !== "string" ||
        !operations.environments.some((entry) => entry.environment?.name === environment)
      )
        throw new Error("Unknown source environment");
      return {
        scopes: ["run_case", "observe_case", "cancel_case"],
        handler: automationTools(
          clients,
          sync,
          config.namespace,
          environment,
          nativeInvocation(
            new URL("/mcp/kagent-collaboration", knowledge.url),
            process.env.AGENTOS_COLLABORATION_TOKEN ?? knowledge.token,
            config.userId,
          ),
          async (session, cancel, contexts) => {
            const principal = create(ExecutionIdentitySchema, {
              subject: `service:automation:${environment}`,
              write: true,
              capabilities: [Capability.KNOWLEDGE_MANAGE],
              credential: { case: "service", value: true },
            });
            await execution.registry.bind(session, principal);
            if (cancel) {
              await relatedExecutions(
                execution.registry,
                clients.sessions,
                session,
                contexts ?? [],
                true,
              );
              await execution.registry.revoke(session, principal);
            }
          },
        ),
      };
    }
    if (headers["x-agentos-workspace"] !== config.namespace)
      throw new Error("Workspace access denied");
    const scope = await (role === "platform"
      ? Promise.resolve({ scopes: [...(catalog.servers.get("team-sessions")?.keys() ?? [])] })
      : identities.authorize(role, clients).then((scopes) => ({ scopes })));
    if (discoveryMethods.has(method)) return scope;
    const parent = await execution.actor(headers);
    await execution.authorizeTools(parent, [tool]);
    return {
      ...scope,
      handler: scopedCollaboration(
        sessionTools(clients, config.namespace, access, knowledgeService(clients, knowledge)),
        parent,
        execution.registry,
      ),
    };
  },
);
const continueDelegation = continuations(sync, async (contextId, contexts) => {
  const { session: parent } = await clients.sessions.getSession({ sessionId: contextId });
  if (!parent) throw new Error("Execution session is unavailable");
  await relatedExecutions(execution.registry, clients.sessions, parent, contexts);
});
const approvals = approvalCoordinator(
  sync,
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
await sync.refresh();
const jobs = await coordinationQueue(
  process.env.AGENTOS_EXECUTION_DATABASE_URL ?? "",
  config.namespace,
  app.log,
  process.env.AGENTOS_EXECUTION_DATABASE_CA
    ? readFileSync(process.env.AGENTOS_EXECUTION_DATABASE_CA, "utf8")
    : undefined,
);
const stopCoordination = await startCoordination(sync, jobs, [continueDelegation, approvals]);
const processor = grpcServer(app, {
  fallback: environmentAuthorization(execution.authorizeTransport),
  routes: (router) => {
    const collaboration = collaborationGuardrails(
      new Map([[config.namespace, clients]]),
      execution,
    );
    router.service(ExtMcp, {
      checkRequest: (request, context) =>
        request.metadataContext?.execution === true
          ? execution.guardrails.checkRequest(request, context)
          : collaboration.checkRequest(request, context),
      checkResponse: (request, context) =>
        request.metadataContext?.execution === true
          ? execution.guardrails.checkResponse(request, context)
          : collaboration.checkResponse(request, context),
    });
  },
});
const runtimeProcessor = grpcServer(app, {
  routes: (router) => registerRuntime(router, execution, config, clients, knowledge.scope),
});
app.addHook("onClose", async () => {
  await stopCoordination();
  await jobs.boss.stop({ graceful: true, timeout: 40_000 });
  sync.close();
  await execution.close();
  await tags.close();
});
sync.start();
// Engineer bindings follow the access policy, including after upgrades.
const align = (): void =>
  void identities
    .align(clients, replaceTemplate)
    .then(() => alignRoles())
    .then(async (updated) => {
      await automation.seed(clients);
      if (updated.length) app.log.info({ updated }, "engineer bindings aligned with access policy");
    })
    .catch((error: unknown) => {
      app.log.warn({ err: error }, "engineer binding alignment failed; retrying");
      setTimeout(align, 30_000).unref();
    });
align();
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => void app.close());
await Promise.all([
  processor.listen(Number(process.env.AGENTOS_GUARDRAILS_PORT ?? "9090"), listenConfig().host),
  runtimeProcessor.listen(Number(process.env.AGENTOS_RUNTIME_PORT ?? "9091"), listenConfig().host),
]);
await app.listen(listenConfig());
