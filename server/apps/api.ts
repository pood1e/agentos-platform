import { resolve } from "node:path";
import { CoreV1Api } from "@kubernetes/client-node";
import { registerDelegation } from "../authorization/delegation.js";
import { automationPresets } from "../automation/presets.js";
import { automationService } from "../automation/service.js";
import { presetStore } from "../automation/store.js";
import { registerConsole } from "../console/app.js";
import { loadPack } from "../console/pack.js";
import { consoleService } from "../console/service.js";
import { templateWriter } from "../console/template-writer.js";
import { approvalJobs } from "../governance/coordinator.js";
import { enqueueCoordination } from "../jobs/coordination.js";
import { configurationClients } from "../kagent/configuration.js";
import { knowledgeConfig } from "../knowledge/config.js";
import { resourceStore } from "../management/resources.js";
import { managementService } from "../management/service.js";
import { mcpApps } from "../mcp-apps/service.js";
import { workspaceContext } from "../platform/access.js";
import { registerEnvironmentApis } from "../platform/environment-api.js";
import { listenConfig, requiredEnv, roleDefaults } from "../shared/config.js";
import { registerHealth } from "../shared/health.js";
import { voiceCalls } from "../speech/calls.js";
import { speechService } from "../speech/service.js";
import { speechSettingsStore } from "../speech/store.js";
import { registerTranscription } from "../speech/transcription.js";
import { taskTagStore } from "../tasks/store.js";
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
const { access, operations, environmentToken, metadata, oauth, identity, execution } =
  await executionServices(config, configuration.clients, app.log);
const { projection, jobs } = await projectionServices(config, clients, execution.store, app.log);
enqueueCoordination(projection, jobs, [continuationJobs, approvalJobs(operations)]);
await projection.listen();
const tags = await taskTagStore(config.database.uri, workspace, config.database.ca);
const presets = await presetStore(config.database.uri, workspace, config.database.ca);

const origin = requiredEnv("AGENTOS_API_ORIGIN");
const packRoot = process.env.AGENTOS_PACK_DIR ? resolve(process.env.AGENTOS_PACK_DIR) : undefined;
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
registerEnvironmentApis(app, operations, environmentToken, identity);
const speechSettings = speechSettingsStore(
  config.kube.makeApiClient(CoreV1Api),
  workspace,
  process.env.AGENTOS_SPEECH_SECRET ?? `${release}-speech`,
);
const speech = speechService(
  speechSettings.load,
  voiceCalls(speechSettings.load, process.env.AGENTOS_VOICE_URL, process.env.AGENTOS_VOICE_TOKEN),
);
await registerTranscription(app, speechSettings.load, async (headers) => {
  await identity(headers);
});
const automation = automationPresets(workspace, packRoot);
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
      operations,
      metadata,
      sandboxOrigin: process.env.AGENTOS_SANDBOX_ORIGIN ?? "",
      token: environmentToken,
      log: app.log,
    }),
    projection,
    clients,
    namespace: workspace,
    access,
    operations,
    environmentToken,
    roleDefaults: roleDefaults(),
    replaceTemplate: templateWriter(config.kube),
    pack: loadPack(packRoot),
    tags,
    speech,
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
  automation: automationService(
    clients,
    workspace,
    { eventTriggers: automation.eventTriggers, scheduledRuns: presets.list },
    operations.environments.flatMap((entry) => entry.environment?.name ?? []),
    process.env.AGENTOS_EVENT_AUTOMATION_ENABLED === "true",
    projection,
  ),
  packRoot,
});
registerHealth(app, () => projection.healthy() && configuration.healthy() && access.healthy());
closeOnSignal(app, [
  () => jobs.boss.stop({ graceful: true, timeout: 10_000 }),
  projection.close,
  configuration.close,
  access.close,
  execution.close,
  tags.close,
  presets.close,
]);
await app.listen(listenConfig());
