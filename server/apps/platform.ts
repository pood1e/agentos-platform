import { KubeConfig } from "@kubernetes/client-node";
import Fastify, { type FastifyInstance, LogController } from "fastify";

export function platformKube() {
  const kube = new KubeConfig();
  kube.loadFromDefault();
  return kube;
}

export const platformApp = () =>
  Fastify({
    logger: true,
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 2 * 1024 * 1024,
  });

export function closeOnSignal(app: FastifyInstance, steps: (() => unknown)[]) {
  app.addHook("onClose", async () => {
    for (const step of steps) await step();
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => void app.close());
}
