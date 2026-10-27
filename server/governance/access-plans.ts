import type { KubeConfig } from "@kubernetes/client-node";
import type { FastifyBaseLogger } from "fastify";
import { watchAccessPlans } from "../../shared/access-plans.js";

export type { AccessPlan } from "../../shared/access-plans.js";

export function toolBindings(
  config: KubeConfig,
  namespace: string,
  log: Pick<FastifyBaseLogger, "error">,
) {
  return watchAccessPlans(config, namespace, "platform", log);
}
