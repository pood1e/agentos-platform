import { KubeConfig } from "@kubernetes/client-node";
import Fastify, { LogController } from "fastify";
import { kagentClients, kagentTransport } from "../kagent/clients.js";
import { nativeInvocation } from "../kagent/invoke-session.js";
import { knowledgeConfig } from "../knowledge/config.js";
import { knowledgeService } from "../knowledge/service.js";
import { toolBindings } from "../operations/bindings.js";
import { operationsConfig } from "../operations/config.js";
import { operationsCoordinator } from "../operations/coordinator.js";
import { TaskIndex } from "../read-model/index.js";
import { KagentSync } from "../read-model/sync.js";
import { kagentConfig, listenConfig } from "../shared/config.js";
import { registerTeamSessions } from "./app.js";
import { startContinuations } from "./continuation.js";
import { sessionTools } from "./tools.js";

const token = process.env.AGENTOS_MCP_TOKEN;
if (!token) throw new Error("AGENTOS_MCP_TOKEN is required");

const config = kagentConfig();
const kubeConfig = new KubeConfig();
kubeConfig.loadFromDefault();
const app = Fastify({
  logger: true,
  logController: new LogController({ disableRequestLogging: true }),
});
const clients = kagentClients(kagentTransport(config));
const knowledge = knowledgeConfig(config);
const sync = new KagentSync(clients, config.namespace, new TaskIndex(), app.log);
await registerTeamSessions(
  app,
  sessionTools(
    clients,
    config.namespace,
    toolBindings(kubeConfig, config.namespace),
    knowledgeService(clients, knowledge),
    nativeInvocation(
      new URL("/mcp/kagent-collaboration", knowledge.url),
      knowledge.token,
      config.userId,
    ),
  ),
  token,
  sync.healthy,
);

const stop = startContinuations(sync, app.log);
const stopOperations = operationsCoordinator(sync, operationsConfig(), app.log);
app.addHook("onClose", async () => {
  stop();
  stopOperations();
  sync.close();
});
sync.start();
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => void app.close());
await app.listen(listenConfig(process.env, 8081));
