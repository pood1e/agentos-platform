import { KubeConfig } from "@kubernetes/client-node";
import Fastify, { type FastifyInstance, LogController } from "fastify";
import { kagentClients, kagentTransport } from "../kagent/clients.js";
import { kagentConfig } from "../shared/config.js";

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

export function closeOnSignal(app: FastifyInstance, steps: (() => unknown)[]) {
  app.addHook("onClose", async () => {
    for (const step of steps) await step();
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => void app.close());
}
