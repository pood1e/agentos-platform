import { create, type JsonObject, type MessageInitShape } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import {
  CustomObjectsApi,
  type KubeConfig,
  type KubernetesObject,
  makeInformer,
} from "@kubernetes/client-node";
import type { FastifyBaseLogger } from "fastify";
import {
  AgentTemplateSchema,
  GetAgentTemplateResponseSchema,
} from "../../gen/kagent/api/v1/agent_templates_pb.js";
import { AgentSchema, GetAgentResponseSchema } from "../../gen/kagent/api/v1/agents_pb.js";
import type { ResourceReferenceSchema } from "../../gen/kagent/api/v1/common_pb.js";
import {
  HarnessSchema,
  ListHarnessesResponseSchema,
} from "../../gen/kagent/api/v1/harnesses_pb.js";
import {
  GetModelConfigResponseSchema,
  ModelConfigSchema,
} from "../../gen/kagent/api/v1/models_pb.js";
import type { KagentClients } from "./clients.js";

type NativeResource = KubernetesObject & JsonObject;
const types = {
  agents: ["api.kagent.dev", "v1alpha3", "agents"],
  templates: ["api.kagent.dev", "v1alpha3", "agenttemplates"],
  models: ["api.kagent.dev", "v1alpha3", "modelconfigs"],
  harnesses: ["api.kagent.dev", "v1alpha3", "harnesses"],
  backends: ["agentgateway.dev", "v1alpha1", "agentgatewaybackends"],
} as const;

/** Native informers cache configuration, while Actor identity and execution revocation remain live. */
export async function configurationClients(
  config: KubeConfig,
  namespace: string,
  clients: KagentClients,
  log: Pick<FastifyBaseLogger, "error">,
) {
  const api = config.makeApiClient(CustomObjectsApi);
  let closed = false;
  const watches = Object.entries(types).map(([name, [group, version, plural]]) => {
    let ready = false;
    let initialized = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const informer = makeInformer<NativeResource>(
      config,
      `/apis/${group}/${version}/namespaces/${namespace}/${plural}`,
      async () => {
        const result = (await api.listNamespacedCustomObject({
          group,
          version,
          plural,
          namespace,
        })) as { items: NativeResource[]; metadata: { resourceVersion: string } };
        ready = true;
        initialized = true;
        return result;
      },
    );
    informer.on("error", (error: unknown) => {
      ready = false;
      // Stopping the informer aborts its watch.
      if (closed) return;
      log.error({ err: error, resource: name }, "Configuration watch unavailable");
      if (!retry)
        retry = setTimeout(() => {
          retry = undefined;
          void informer.start();
        }, 1_000);
    });
    informer.on("connect", () => {
      ready = initialized;
    });
    return {
      name,
      informer,
      healthy: () => ready,
      read() {
        if (closed || !ready)
          throw new ConnectError("Configuration watch unavailable", Code.Unavailable);
        return informer.list(namespace);
      },
      async close() {
        if (retry) clearTimeout(retry);
        await informer.stop();
      },
    };
  });
  const list = (kind: keyof typeof types) =>
    watches.find((watch) => watch.name === kind)?.read() ?? [];
  const get = (
    kind: keyof typeof types,
    ref: MessageInitShape<typeof ResourceReferenceSchema> | undefined,
  ) => {
    if (!ref?.name || ref.namespace !== namespace)
      throw new ConnectError("Configuration reference invalid", Code.PermissionDenied);
    const resource = list(kind).find((item) => item.metadata?.name === ref.name);
    if (!resource) throw new ConnectError("Configuration resource unavailable", Code.NotFound);
    return {
      ref,
      resource: {
        apiVersion: resource.apiVersion ?? "",
        kind: resource.kind ?? "",
        value: structuredClone(resource),
      },
    };
  };
  try {
    await Promise.all(watches.map(({ informer }) => informer.start()));
  } catch (error) {
    closed = true;
    await Promise.all(watches.map((watch) => watch.close()));
    throw error;
  }
  return {
    clients: {
      ...clients,
      agents: {
        ...clients.agents,
        getAgent: async (request) =>
          create(GetAgentResponseSchema, {
            agent: create(AgentSchema, get("agents", request.ref)),
          }),
      },
      templates: {
        ...clients.templates,
        getAgentTemplate: async (request) =>
          create(GetAgentTemplateResponseSchema, {
            agentTemplate: create(AgentTemplateSchema, get("templates", request.ref)),
          }),
      },
      models: {
        ...clients.models,
        getModelConfig: async (request) =>
          create(GetModelConfigResponseSchema, {
            modelConfig: create(ModelConfigSchema, get("models", request.ref)),
          }),
      },
      harnesses: {
        ...clients.harnesses,
        listHarnesses: async (request) => {
          if (request.namespace !== namespace)
            throw new ConnectError("Configuration namespace invalid", Code.PermissionDenied);
          return create(ListHarnessesResponseSchema, {
            harnesses: list("harnesses").map((item) =>
              create(
                HarnessSchema,
                get("harnesses", { namespace, name: item.metadata?.name ?? "" }),
              ),
            ),
          });
        },
      },
    } satisfies KagentClients,
    backends: async () => structuredClone([...list("backends")]),
    healthy: () => !closed && watches.every((watch) => watch.healthy()),
    async close() {
      closed = true;
      await Promise.all(watches.map((watch) => watch.close()));
    },
  };
}
