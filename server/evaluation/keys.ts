import { createHash, randomBytes } from "node:crypto";
import type { JsonObject } from "@bufbuild/protobuf";
import {
  ApiException,
  CoreV1Api,
  type KubeConfig,
  KubernetesObjectApi,
  PatchStrategy,
} from "@kubernetes/client-node";

/** Ephemeral machine access uses agentgateway's native ConfigMap API-key provider. */
export function evaluationKeys(
  config: KubeConfig,
  namespace: string,
  gatewayNamespace: string,
  release: string,
) {
  const core = config.makeApiClient(CoreV1Api),
    api = KubernetesObjectApi.makeApiClient(config);
  async function issue(name: string, candidate: string, metadata: JsonObject, gateway = release) {
    const existing = await core
      .readNamespacedSecret({ namespace, name })
      .catch((error: unknown) => {
        if (error instanceof ApiException && error.code === 404) return undefined;
        throw error;
      });
    if (existing && existing.metadata?.labels?.["agentos.dev/candidate"] !== candidate)
      throw new Error("Evaluation credential belongs to another candidate");
    const token = existing?.data?.["api-key"]
      ? Buffer.from(existing.data["api-key"], "base64").toString()
      : randomBytes(32).toString("base64url");
    const labels = { "agentos.dev/candidate": candidate, "agentos.dev/gateway-keys": gateway };
    if (!existing)
      await core.createNamespacedSecret({
        namespace,
        body: {
          apiVersion: "v1",
          kind: "Secret",
          type: "Opaque",
          metadata: { name, namespace, labels },
          stringData: { "api-key": token, authorization: `Bearer ${token}` },
        },
      });
    await api.patch(
      {
        apiVersion: "v1",
        kind: "ConfigMap",
        metadata: { name, namespace: gateway === release ? gatewayNamespace : namespace, labels },
        data: {
          key: JSON.stringify({
            keyHash: `sha256:${createHash("sha256").update(token).digest("hex")}`,
            metadata,
          }),
        },
      },
      undefined,
      undefined,
      "agentos-evaluations",
      false,
      PatchStrategy.ServerSideApply,
    );
    return token;
  }
  async function revoke(candidate: string) {
    for (const ns of new Set([namespace, gatewayNamespace])) {
      const keys = await core.listNamespacedConfigMap({
        namespace: ns,
        labelSelector: `agentos.dev/candidate=${candidate},agentos.dev/gateway-keys`,
      });
      for (const item of keys.items)
        if (item.metadata?.name)
          await core.deleteNamespacedConfigMap({
            namespace: ns,
            name: item.metadata.name,
            body: { preconditions: { uid: item.metadata.uid } },
          });
    }
  }
  return { issue, revoke };
}
