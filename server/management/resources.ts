import type { JsonObject } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import {
  ApiException,
  CoreV1Api,
  CustomObjectsApi,
  type KubeConfig,
} from "@kubernetes/client-node";
import { object } from "../read-model/decode/messages.js";
import { conflict, fail, invalid, notFound } from "../shared/errors.js";
import { userResource } from "./native.js";

const resourceKinds = {
  accessPlans: ["agentos.dev", "v1alpha1", "accessplans"],
  models: ["agentgateway.dev", "v1alpha1", "agentgatewaymodels"],
  mcps: ["agentgateway.dev", "v1alpha1", "agentgatewaybackends"],
  mcpPolicies: ["agentgateway.dev", "v1alpha1", "agentgatewaypolicies"],
  routes: ["gateway.networking.k8s.io", "v1", "httproutes"],
  templates: ["api.kagent.dev", "v1alpha3", "agenttemplates"],
  agents: ["api.kagent.dev", "v1alpha3", "agents"],
  harnesses: ["api.kagent.dev", "v1alpha3", "harnesses"],
  modelConfigs: ["api.kagent.dev", "v1alpha3", "modelconfigs"],
  remoteMCPs: ["api.kagent.dev", "v1alpha3", "remotemcpservers"],
} as const;
export type ResourceKind = keyof typeof resourceKinds;

export interface ResourceStore {
  list(kind: ResourceKind): Promise<JsonObject[]>;
  get(kind: ResourceKind, name: string): Promise<JsonObject>;
  save(kind: ResourceKind, resource: JsonObject, create: boolean): Promise<JsonObject>;
  validate(kind: ResourceKind, resource: JsonObject, create?: boolean): Promise<JsonObject>;
  remove(kind: ResourceKind, name: string, version: string): Promise<void>;
  readCatalog(): Promise<{ value: string; version: string }>;
  writeCatalog(value: string, version: string): Promise<string>;
  credential(name: string, value: string, owner: JsonObject): Promise<void>;
}

export function resourceError(error: unknown): never {
  if (error instanceof ConnectError) throw error;
  if (error instanceof ApiException) {
    if (error.code === 409) throw conflict("configuration.conflict");
    if (error.code === 404) throw notFound("management.notFound");
    if (error.code === 400 || error.code === 422) throw invalid("management.invalid");
  }
  throw fail(Code.Unavailable, "management.unavailable");
}

/** Native Kubernetes resources retain their CRD schema and resourceVersion semantics. */
export function resourceStore(
  config: KubeConfig,
  namespace: string,
  catalogName: string,
): ResourceStore {
  const custom = config.makeApiClient(CustomObjectsApi);
  const core = config.makeApiClient(CoreV1Api);
  const params = (kind: ResourceKind) => {
    const [group, version, plural] = resourceKinds[kind];
    return { group, version, plural, namespace };
  };
  return {
    async list(kind) {
      try {
        const list: { items: JsonObject[] } = await custom.listNamespacedCustomObject(params(kind));
        return list.items;
      } catch (error) {
        return resourceError(error);
      }
    },
    async get(kind, name) {
      try {
        return await custom.getNamespacedCustomObject({ ...params(kind), name });
      } catch (error) {
        return resourceError(error);
      }
    },
    async save(kind, resource, create) {
      const metadata = object(resource.metadata);
      const name = String(metadata.name ?? "");
      const claimed = userResource(resource);
      const body: JsonObject = { ...claimed, metadata: { ...object(claimed.metadata), namespace } };
      delete body.status;
      try {
        return create
          ? await custom.createNamespacedCustomObject({
              ...params(kind),
              body,
              fieldValidation: "Strict",
              fieldManager: "agentos-users",
            })
          : await custom.replaceNamespacedCustomObject({
              ...params(kind),
              name,
              body,
              fieldValidation: "Strict",
              fieldManager: "agentos-users",
            });
      } catch (error) {
        return resourceError(error);
      }
    },
    async validate(kind, resource, create = true) {
      try {
        const request = {
          ...params(kind),
          body: resource,
          dryRun: "All",
          fieldValidation: "Strict",
        };
        return create
          ? await custom.createNamespacedCustomObject(request)
          : await custom.replaceNamespacedCustomObject({
              ...request,
              name: String(object(resource.metadata).name ?? ""),
            });
      } catch (error) {
        return resourceError(error);
      }
    },
    async remove(kind, name, version) {
      try {
        await custom.deleteNamespacedCustomObject({
          ...params(kind),
          name,
          body: { preconditions: { resourceVersion: version } },
        });
      } catch (error) {
        return resourceError(error);
      }
    },
    async readCatalog() {
      try {
        const cm = await core.readNamespacedConfigMap({ namespace, name: catalogName });
        return {
          value: cm.data?.["catalog.json"] ?? "{}",
          version: cm.metadata?.resourceVersion ?? "",
        };
      } catch (error) {
        return resourceError(error);
      }
    },
    async writeCatalog(value, version) {
      try {
        const current = await core.readNamespacedConfigMap({ namespace, name: catalogName });
        const cm = await core.replaceNamespacedConfigMap({
          namespace,
          name: catalogName,
          fieldManager: "agentos-users",
          body: {
            apiVersion: "v1",
            kind: "ConfigMap",
            metadata: {
              ...current.metadata,
              annotations: { ...current.metadata?.annotations, "agentos.dev/ownership": "user" },
              ownerReferences: current.metadata?.ownerReferences?.filter(
                (ref) => ref.kind !== "Preset" || ref.apiVersion !== "agentos.dev/v1alpha1",
              ),
              namespace,
              name: catalogName,
              resourceVersion: version,
            },
            data: { ...current.data, "catalog.json": value },
          },
        });
        return cm.metadata?.resourceVersion ?? "";
      } catch (error) {
        return resourceError(error);
      }
    },
    async credential(name, value, owner) {
      const metadata = object(owner.metadata);
      const body = {
        apiVersion: "v1",
        kind: "Secret",
        metadata: {
          name,
          namespace,
          ownerReferences: [
            {
              apiVersion: String(owner.apiVersion),
              kind: String(owner.kind),
              name: String(metadata.name),
              uid: String(metadata.uid),
              controller: true,
            },
          ],
        },
        type: "Opaque",
        stringData: { Authorization: value },
      };
      try {
        const existing = await core
          .readNamespacedSecret({ namespace, name })
          .catch((error: unknown) => {
            if (error instanceof ApiException && error.code === 404) return undefined;
            throw error;
          });
        if (
          existing &&
          !existing.metadata?.ownerReferences?.some((ref) => ref.uid === metadata.uid)
        )
          throw invalid("management.credentialOwner");
        await (existing
          ? core.replaceNamespacedSecret({
              namespace,
              name,
              body: {
                ...body,
                metadata: { ...body.metadata, resourceVersion: existing.metadata?.resourceVersion },
              },
            })
          : core.createNamespacedSecret({
              namespace,
              body,
            }));
      } catch (error) {
        return resourceError(error);
      }
    },
  };
}
