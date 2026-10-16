import { createServer } from "node:http2";
import { resolve } from "node:path";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import { KubeConfig } from "@kubernetes/client-node";
import Fastify, { LogController } from "fastify";
import { ExtMcp } from "../../gen/agentgateway/dev/ext_mcp/ext_mcp_pb.js";
import { registerConsole } from "../console/app.js";
import { loadPack } from "../console/pack.js";
import { roleCommands } from "../console/roles.js";
import { consoleService } from "../console/service.js";
import { templateWriter } from "../console/template-writer.js";
import { kagentClients, kagentTransport } from "../kagent/clients.js";
import { nativeInvocation } from "../kagent/invoke-session.js";
import { knowledgeConfig } from "../knowledge/config.js";
import { knowledgeService } from "../knowledge/service.js";
import { resourceStore } from "../management/resources.js";
import { managementService } from "../management/service.js";
import { toolBindings } from "../operations/bindings.js";
import { loadCatalog } from "../operations/catalog.js";
import { operationsConfig } from "../operations/config.js";
import { operationsCoordinator } from "../operations/coordinator.js";
import { changePreparation } from "../operations/preparation.js";
import { TaskIndex } from "../read-model/index.js";
import { KagentSync } from "../read-model/sync.js";
import { kagentConfig, listenConfig, roleDefaults } from "../shared/config.js";
import { registerTeamSessions } from "../team-sessions/app.js";
import { startContinuations } from "../team-sessions/continuation.js";
import { sessionTools } from "../team-sessions/tools.js";
import { authorizationConfig, humanAuthorization } from "./authorization.js";
import { collaborationGuardrails } from "./guardrails.js";
import { machineIdentities } from "./machine-identities.js";

const config = kagentConfig();
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
const operations = operationsConfig();
const catalog = loadCatalog();
const knowledge = knowledgeConfig(config);
const replaceTemplate = templateWriter(kubeConfig);
const identities = machineIdentities(
  kubeConfig,
  config.namespace,
  process.env.AGENTOS_RELEASE ?? "agentos",
);
const { alignRoles } = roleCommands(
  clients,
  config.namespace,
  access,
  roleDefaults(),
  replaceTemplate,
  identities.bind,
);
await registerConsole(app, {
  authorization: humanAuthorization(config.namespace, authorizationConfig()),
  service: consoleService({
    sync,
    clients,
    namespace: config.namespace,
    access,
    operations,
    roleDefaults: roleDefaults(),
    replaceTemplate,
    pack: loadPack(packRoot),
    platformTools: identities.bind,
  }),
  management: managementService({
    clients,
    store: resourceStore(
      kubeConfig,
      config.namespace,
      process.env.AGENTOS_SKILL_CATALOG ?? "agentos-skills",
    ),
    gateway: {
      name: process.env.AGENTOS_GATEWAY_NAME ?? "agentos-gateway",
      url: process.env.AGENTOS_GATEWAY_URL ?? "http://agentos-gateway:8080",
      mcpUrl:
        process.env.AGENTOS_MCP_GATEWAY_URL ??
        process.env.AGENTOS_GATEWAY_URL ??
        "http://agentos-mcp-gateway:8080",
      namespace: config.namespace,
      secret: process.env.AGENTOS_GATEWAY_SECRET ?? "agentos-gateway",
    },
    knowledge,
    operations,
  }),
  ready: sync.healthy,
  staticRoot: resolve(process.env.AGENTOS_STATIC_ROOT ?? "dist"),
  packRoot,
});
await registerTeamSessions(
  app,
  sessionTools(
    clients,
    config.namespace,
    access,
    knowledgeService(clients, knowledge),
    nativeInvocation(
      new URL("/mcp/kagent-collaboration", knowledge.url),
      process.env.AGENTOS_COLLABORATION_TOKEN ?? knowledge.token,
      config.userId,
    ),
    changePreparation(clients, config.namespace, operations.environments, catalog),
  ),
  token,
  (role) =>
    role === "platform"
      ? Promise.resolve({ scopes: [...(catalog.servers.get("team-sessions")?.keys() ?? [])] })
      : identities.authorize(role, clients).then((scopes) => ({ scopes })),
);
const stopContinuations = startContinuations(sync, app.log);
const stopOperations = operationsCoordinator(sync, operations, app.log, catalog);
const processor = createServer(
  connectNodeAdapter({
    routes: (router) =>
      router.service(ExtMcp, collaborationGuardrails(clients, new Set([config.namespace]))),
  }),
);
app.addHook("onClose", async () => {
  stopContinuations();
  stopOperations();
  sync.close();
  await new Promise<void>((resolve) => processor.close(() => resolve()));
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
