import { CoreV1Api } from "@kubernetes/client-node";
import { registerDelegation } from "../authorization/delegation.js";
import { registerConsole } from "../console/app.js";
import { consoleService } from "../console/service.js";
import { templateWriter } from "../console/template-writer.js";
import { configurationClients } from "../kagent/configuration.js";
import { knowledgeConfig } from "../knowledge/config.js";
import { resourceStore } from "../management/resources.js";
import { managementService } from "../management/service.js";
import { mcpApps } from "../mcp-apps/service.js";
import { workspaceContext } from "../platform/access.js";
import { listenConfig, requiredEnv, roleDefaults } from "../shared/config.js";
import { registerHealth } from "../shared/health.js";
import { voiceFeature } from "../voice/feature.js";
import { speechSettingsStore } from "../voice/settings.js";
import {
  closeOnSignal,
  executionServices,
  platformApp,
  platformClients,
  platformConfig,
  queryServices,
} from "./platform.js";

const config = platformConfig();
const { workspace } = config;
const app = platformApp();
const clients = platformClients(config);
const configuration = await configurationClients(config.kube, workspace, clients, app.log);
const { access, metadata, oauth, identity, execution } = await executionServices(
  config,
  configuration.clients,
  app.log,
);
const projection = queryServices(config, clients, execution.store);

const origin = requiredEnv("AGENTOS_API_ORIGIN");
const entryAgent = process.env.AGENTOS_ENTRY_AGENT ?? "assistant";
const release = process.env.AGENTOS_RELEASE ?? "agentos";
await registerDelegation(app, {
  origin,
  returnOrigins: JSON.parse(requiredEnv("AGENTOS_DELEGATION_ORIGINS")),
  client: oauth,
  key: Buffer.from(requiredEnv("AGENTOS_COOKIE_SECRET"), "base64"),
  grants: execution.background,
  executions: execution.registry,
});
const speechSettings = speechSettingsStore(
  config.kube.makeApiClient(CoreV1Api),
  workspace,
  process.env.AGENTOS_SPEECH_SECRET ?? `${release}-speech`,
);
const voice = await voiceFeature(app, {
  database: config.database,
  kube: config.kube,
  settings: speechSettings.load,
  projection,
  clients,
  executions: execution.registry,
  initiator: (subject) => execution.background.resolve(subject),
  agent: { namespace: workspace, name: entryAgent },
});
const knowledge = knowledgeConfig(config.kagent);
const gateway = {
  name: process.env.AGENTOS_GATEWAY_NAME ?? "agentos-gateway",
  url: process.env.AGENTOS_GATEWAY_URL ?? "http://agentos-gateway:8080",
  mcpUrl:
    process.env.AGENTOS_MCP_GATEWAY_URL ??
    process.env.AGENTOS_GATEWAY_URL ??
    "http://agentos-mcp-gateway:8080",
  namespace: workspace,
  secret: `${release}-model-client`,
};
await registerConsole(app, {
  context: workspaceContext(workspace, entryAgent, identity, execution.registry.remember),
  service: consoleService({
    metadata,
    apps: mcpApps({
      clients,
      projection,
      namespace: workspace,
      access,
      metadata,
      sandboxOrigin: process.env.AGENTOS_SANDBOX_ORIGIN ?? "",
      gatewayURL: gateway.url,
      log: app.log,
    }),
    projection,
    clients,
    namespace: workspace,
    access,
    roleDefaults: roleDefaults(),
    replaceTemplate: templateWriter(config.kube),
    voice: voice?.console,
    executions: execution.registry,
    entryAgent,
    authorizeTools: execution.authorizeTools,
    delegationUrl: `${origin}/delegation/start`,
  }),
  management: managementService({
    clients,
    store: resourceStore(
      config.kube,
      workspace,
      process.env.AGENTOS_SKILL_CATALOG ?? "agentos-skills",
    ),
    gateway,
    knowledge,
    speech: speechSettings,
  }),
});
registerHealth(app, () => configuration.healthy() && access.healthy());
closeOnSignal(app, [
  configuration.close,
  access.close,
  execution.close,
  ...(voice ? [voice.close] : []),
]);
await voice?.listen(listenConfig().host);
await app.listen(listenConfig());
