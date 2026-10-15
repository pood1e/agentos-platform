import { resolve } from "node:path";
import { KubeConfig } from "@kubernetes/client-node";
import Fastify, { LogController } from "fastify";
import { kagentClients, kagentTransport } from "../kagent/clients.js";
import { knowledgeConfig } from "../knowledge/config.js";
import { resourceStore } from "../management/resources.js";
import { managementService } from "../management/service.js";
import { toolBindings } from "../operations/bindings.js";
import { operationsConfig } from "../operations/config.js";
import { TaskIndex } from "../read-model/index.js";
import { KagentSync } from "../read-model/sync.js";
import { kagentConfig, listenConfig, roleDefaults } from "../shared/config.js";
import { registerConsole } from "./app.js";
import { loadPack } from "./pack.js";
import { roleCommands } from "./roles.js";
import { consoleService } from "./service.js";
import { templateWriter } from "./template-writer.js";

const config = kagentConfig();
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
const replaceTemplate = templateWriter(kubeConfig);
const { alignRoles } = roleCommands(
  clients,
  config.namespace,
  access,
  roleDefaults(),
  replaceTemplate,
);
await registerConsole(app, {
  service: consoleService({
    sync,
    clients,
    namespace: config.namespace,
    access,
    operations,
    roleDefaults: roleDefaults(),
    replaceTemplate,
    pack: loadPack(packRoot),
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
    knowledge: knowledgeConfig(config),
    operations,
  }),
  ready: sync.healthy,
  staticRoot: resolve(process.env.AGENTOS_STATIC_ROOT ?? "dist"),
  packRoot,
});
app.addHook("onClose", async () => sync.close());
sync.start();
// Engineer bindings follow the access policy, including after upgrades.
const align = (): void =>
  void alignRoles()
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
