import { AuthenticationV1Api } from "@kubernetes/client-node";
import { serviceAccountTokens } from "../authorization/workloads.js";
import { toolBindings } from "../governance/access-plans.js";
import { kagentClients, kagentTransport } from "../kagent/clients.js";
import { listenConfig, requiredEnv } from "../shared/config.js";
import { registerHealth } from "../shared/health.js";
import { registerPlatformMcp } from "../team-sessions/authorization.js";
import { closeOnSignal, platformApp, platformKube } from "./platform.js";

const kube = platformKube();
const namespace = requiredEnv("KAGENT_NAMESPACE");
const app = platformApp();
const clients = kagentClients(kagentTransport(requiredEnv("KAGENT_URL")));
const access = await toolBindings(kube, namespace, app.log);
await registerPlatformMcp(
  app,
  namespace,
  clients,
  access,
  serviceAccountTokens(kube.makeApiClient(AuthenticationV1Api)),
  requiredEnv("AGENTOS_CONTROLLER_SUBJECT"),
);
registerHealth(app, () => access.healthy());
closeOnSignal(app, [access.close]);
await app.listen(listenConfig());
