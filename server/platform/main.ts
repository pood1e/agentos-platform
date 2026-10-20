import { createServer } from "node:http2";
import { resolve } from "node:path";
import { create } from "@bufbuild/protobuf";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import { KubeConfig } from "@kubernetes/client-node";
import Fastify, { LogController } from "fastify";
import { ExtMcp } from "../../gen/agentgateway/dev/ext_mcp/ext_mcp_pb.js";
import { ExecutionIdentitySchema } from "../../gen/agentos/execution/v1/identity_pb.js";
import { loadCatalog } from "../../shared/tool-catalog.js";
import { scopedCollaboration } from "../authorization/context.js";
import { relatedExecutions } from "../authorization/executions.js";
import { discoveryMethods } from "../authorization/mcp.js";
import { registerRuntime } from "../authorization/native.js";
import { oidcIdentity } from "../authorization/oidc.js";
import { executionRuntime } from "../authorization/runtime.js";
import { registerConsole } from "../console/app.js";
import { loadPack } from "../console/pack.js";
import { roleCommands } from "../console/roles.js";
import { consoleService } from "../console/service.js";
import { templateWriter } from "../console/template-writer.js";
import { platformEvaluation } from "../evaluation/platform.js";
import { toolBindings } from "../governance/bindings.js";
import { governanceConfig } from "../governance/config.js";
import { approvalCoordinator } from "../governance/coordinator.js";
import { kagentClients, kagentTransport } from "../kagent/clients.js";
import { nativeInvocation } from "../kagent/invoke-session.js";
import { knowledgeConfig } from "../knowledge/config.js";
import { knowledgeService } from "../knowledge/service.js";
import { resourceStore } from "../management/resources.js";
import { managementService } from "../management/service.js";
import { TaskIndex } from "../read-model/index.js";
import { KagentSync } from "../read-model/sync.js";
import { kagentConfig, listenConfig, roleDefaults } from "../shared/config.js";
import { registerTeamSessions } from "../team-sessions/app.js";
import { startContinuations } from "../team-sessions/continuation.js";
import { sessionTools } from "../team-sessions/tools.js";
import { workspaceContext } from "./access.js";
import { automationTools } from "./automation.js";
import { collaborationGuardrails } from "./guardrails.js";
import { machineIdentities } from "./machine-identities.js";

const config = kagentConfig();
const authentication = process.env.AGENTOS_AUTH_MODE ?? "none";
if (!["none", "oidc"].includes(authentication)) throw new Error("Unknown authentication mode");
const identity =
  authentication === "oidc"
    ? await oidcIdentity({
        issuer: process.env.AGENTOS_OIDC_ISSUER ?? "",
        audience: process.env.AGENTOS_OIDC_AUDIENCE ?? "",
        writerRole: process.env.AGENTOS_OIDC_WRITER_ROLE ?? "",
        origin: process.env.AGENTOS_ORIGIN ?? "",
      })
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
const execution = await executionRuntime(clients, config.namespace, access, identity);
const operations = governanceConfig();
const catalog = loadCatalog();
const knowledge = knowledgeConfig(config);
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
      roleDefaults: roleDefaults(),
      replaceTemplate: replace,
      pack,
      platformTools: bind,
      executions: execution.registry,
      authorizeTools: execution.authorizeTools,
    }),
    management: managementService({
      clients: native,
      store: resources,
      gateway,
      knowledge,
      operations,
    }),
  };
}
const evaluation = await platformEvaluation({
  app,
  config: kubeConfig,
  native: clients,
  store,
  workspace: config.namespace,
  release: process.env.AGENTOS_RELEASE ?? "agentos",
  catalogName,
  knowledge,
  userId: config.userId,
  mcpUrl: gateway.mcpUrl,
  bind: identities.bind,
  bindExecution: (session) =>
    execution.registry.bind(
      session,
      create(ExecutionIdentitySchema, {
        subject: `service:evaluation:${session.agent?.namespace}`,
        write: false,
        credential: { case: "service", value: true },
      }),
    ),
  services: (draft) =>
    services(draft.clients(clients), draft.store, draft.replace, async (_role, tools) => tools),
});
const activeClients = evaluation.clients;
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
  ...services(activeClients),
  ...evaluation.routes,
  ready: sync.healthy,
  staticRoot: resolve(process.env.AGENTOS_STATIC_ROOT ?? "dist"),
  packRoot,
});
await registerTeamSessions(
  app,
  sessionTools(activeClients, config.namespace, access, knowledgeService(activeClients, knowledge)),
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
          activeClients,
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
    const scope: { scopes: string[]; handler?: ReturnType<typeof sessionTools> } = await (headers[
      "x-agentos-workspace"
    ] && headers["x-agentos-workspace"] !== config.namespace
      ? evaluation.machine(headers, role)
      : role === "platform"
        ? Promise.resolve({ scopes: [...(catalog.servers.get("team-sessions")?.keys() ?? [])] })
        : identities.authorize(role, clients).then((scopes) => ({ scopes })));
    if (discoveryMethods.has(method)) return scope;
    const parent = await execution.actor(headers);
    await execution.authorizeTools(parent, [tool]);
    return {
      ...scope,
      handler: scopedCollaboration(
        scope.handler ??
          sessionTools(
            activeClients,
            config.namespace,
            access,
            knowledgeService(activeClients, knowledge),
          ),
        parent,
        execution.registry,
      ),
    };
  },
);
const stopContinuations = startContinuations(sync, app.log, async (contextId, contexts) => {
  const { session: parent } = await clients.sessions.getSession({ sessionId: contextId });
  if (!parent) throw new Error("Execution session is unavailable");
  await relatedExecutions(execution.registry, clients.sessions, parent, contexts);
});
const stopOperations = approvalCoordinator(sync, operations, app.log, async (contextId, tools) => {
  const { session } = await clients.sessions.getSession(
    { sessionId: contextId },
    { timeoutMs: 5_000 },
  );
  if (!session) throw new Error("Execution session is unavailable");
  await execution.authorizeTools(session, tools);
});
const processor = createServer(
  connectNodeAdapter({
    routes: (router) => {
      const collaboration = collaborationGuardrails(evaluation.workspaces, execution);
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
  }),
);
const runtimeProcessor = createServer(
  connectNodeAdapter({ routes: (router) => registerRuntime(router, execution, config, clients) }),
);
app.addHook("onClose", async () => {
  stopContinuations();
  stopOperations();
  sync.close();
  await new Promise<void>((resolve) => processor.close(() => resolve()));
  await new Promise<void>((resolve) => runtimeProcessor.close(() => resolve()));
  await execution.close();
});
sync.start();
// Engineer bindings follow the access policy, including after upgrades.
const align = (): void =>
  void identities
    .align(clients, replaceTemplate)
    .then(() => alignRoles())
    .then((updated) => {
      if (updated.length) app.log.info({ updated }, "engineer bindings aligned with access policy");
    })
    .catch((error: unknown) => {
      app.log.warn({ err: error }, "engineer binding alignment failed; retrying");
      setTimeout(align, 30_000).unref();
    });
align();
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => void app.close());
await app.listen(listenConfig());
processor.listen(Number(process.env.AGENTOS_GUARDRAILS_PORT ?? "9090"), listenConfig().host);
runtimeProcessor.listen(Number(process.env.AGENTOS_RUNTIME_PORT ?? "9091"), listenConfig().host);
