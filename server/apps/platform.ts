import { KubeConfig } from "@kubernetes/client-node";
import Fastify, { type FastifyInstance, LogController } from "fastify";
import { discovery } from "openid-client";
import { userIdentity } from "../authorization/identity.js";
import { toolBindings } from "../governance/bindings.js";
import { type KagentClients, kagentClients, kagentTransport } from "../kagent/clients.js";
import { toolMetadata } from "../kagent/tool-metadata.js";
import { taskQueries } from "../read-model/queries.js";
import { kagentConfig, requiredEnv } from "../shared/config.js";

export function platformConfig() {
  const kube = new KubeConfig();
  kube.loadFromDefault();
  const kagent = kagentConfig();
  return { kagent, workspace: kagent.namespace, kube };
}
export type PlatformConfig = ReturnType<typeof platformConfig>;
export const platformApp = () =>
  Fastify({
    logger: true,
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 2 * 1024 * 1024,
  });
export const platformClients = (config: PlatformConfig) =>
  kagentClients(kagentTransport(config.kagent));

export async function consoleDependencies(
  config: PlatformConfig,
  clients: KagentClients,
  log: FastifyInstance["log"],
) {
  const oauth = await discovery(
    new URL(requiredEnv("AGENTOS_OIDC_ISSUER")),
    requiredEnv("AGENTOS_OIDC_CLIENT_ID"),
    requiredEnv("AGENTOS_OIDC_CLIENT_SECRET"),
  );
  oauth.timeout = 10;
  return {
    access: await toolBindings(config.kube, config.workspace, log),
    metadata: toolMetadata(clients),
    oauth,
    identity: userIdentity(clients, requiredEnv("AGENTOS_OIDC_WRITER_ROLE")),
  };
}
export const queryServices = (config: PlatformConfig, clients: KagentClients) =>
  taskQueries({ workspace: config.workspace, clients });

export function closeOnSignal(app: FastifyInstance, steps: (() => unknown)[]) {
  app.addHook("onClose", async () => {
    for (const step of steps) await step();
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => void app.close());
}
