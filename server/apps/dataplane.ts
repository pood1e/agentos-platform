import { AuthenticationV1Api } from "@kubernetes/client-node";
import { serviceAccountTokens } from "../authorization/workloads.js";
import { toolBindings } from "../governance/bindings.js";
import { registerPlatformMcp } from "../platform/mcp.js";
import { listenConfig, requiredEnv } from "../shared/config.js";
import { registerHealth } from "../shared/health.js";
import { closeOnSignal, platformApp, platformClients, platformConfig } from "./platform.js";

const config = platformConfig();
const app = platformApp();
const clients = platformClients(config);
const access = await toolBindings(config.kube, config.workspace, app.log);
await registerPlatformMcp(
  app,
  config.workspace,
  clients,
  access,
  serviceAccountTokens(config.kube.makeApiClient(AuthenticationV1Api)),
  requiredEnv("AGENTOS_CONTROLLER_SUBJECT"),
);
registerHealth(app, () => access.healthy());
closeOnSignal(app, [access.close]);
await app.listen(listenConfig());
