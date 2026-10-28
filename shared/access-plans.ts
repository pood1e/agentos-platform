import { isDeepStrictEqual } from "node:util";
import { Code, ConnectError } from "@connectrpc/connect";
import {
  CustomObjectsApi,
  type KubeConfig,
  type KubernetesObject,
  makeInformer,
} from "@kubernetes/client-node";
import type { AccessPlanSpec, AccessPlanStatus } from "../gen/kubernetes.js";
import { type Target, ToolBindings } from "./tool-bindings.js";

export type AccessPlan = KubernetesObject & { spec: AccessPlanSpec; status?: AccessPlanStatus };

export function serverTargets(plans: AccessPlan[], mode: AccessPlanSpec["mode"] = "platform") {
  const targets = new Map<string, Target>();
  for (const plan of plans) {
    if (plan.spec.mode !== mode) continue;
    if (
      plan.status?.observedGeneration !== plan.metadata?.generation ||
      !plan.status?.conditions?.some(
        (condition) => condition.type === "Ready" && condition.status === "True",
      )
    )
      throw new ConnectError("Authorization plan is not ready", Code.Unavailable);
    for (const target of plan.status.targets ?? []) {
      const previous = targets.get(target.server);
      if (previous && !isDeepStrictEqual(previous, target))
        throw new ConnectError(
          "Authorization plans contain conflicting decisions",
          Code.Unavailable,
        );
      targets.set(target.server, target);
    }
  }
  return targets;
}

/** Each process watches compiled decisions; a failed watch or stale generation fails closed. */
export async function watchAccessPlans(
  config: KubeConfig,
  namespace: string,
  mode: AccessPlanSpec["mode"],
  log: { error: (record: { err: unknown }, message: string) => void },
) {
  const api = config.makeApiClient(CustomObjectsApi);
  const resource = { group: "agentos.dev", version: "v1alpha1", plural: "accessplans", namespace };
  let ready = false;
  let closed = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const informer = makeInformer<AccessPlan>(
    config,
    `/apis/agentos.dev/v1alpha1/namespaces/${namespace}/accessplans`,
    async () => {
      const result = (await api.listNamespacedCustomObject(resource)) as {
        items: AccessPlan[];
        metadata: { resourceVersion: string };
      };
      ready = true;
      return result;
    },
  );
  informer.on("error", (error: unknown) => {
    ready = false;
    // Stopping the informer aborts its watch.
    if (closed) return;
    log.error({ err: error }, "Authorization plan watch unavailable");
    if (!retry)
      retry = setTimeout(() => {
        retry = undefined;
        void informer.start();
      }, 1_000);
  });
  await informer.start();
  const read = async () => {
    if (!ready || closed)
      throw new ConnectError("Authorization plan watch unavailable", Code.Unavailable);
    const plans = informer.list(namespace).filter((plan) => plan.spec.mode === mode);
    if (!plans.length) throw new ConnectError("Authorization plan is missing", Code.Unavailable);
    return new ToolBindings(serverTargets(plans, mode));
  };
  return Object.assign(read, {
    healthy: () => ready && !closed,
    async close() {
      closed = true;
      if (retry) clearTimeout(retry);
      await informer.stop();
    },
  });
}
