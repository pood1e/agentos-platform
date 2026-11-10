import { create, type JsonObject } from "@bufbuild/protobuf";
import {
  type Connection,
  ConnectionKind,
  ConnectionSchema,
  MCPCredentialBindingSchema,
} from "../../gen/agentos/management/v1/management_pb.js";
import { ModelConfigSchema } from "../../gen/kagent/api/v1/models_pb.js";
import { type ToolServer, ToolServerSchema } from "../../gen/kagent/api/v1/tools_pb.js";
import { object, text } from "../../shared/json.js";
import { kagentApiVersion } from "../../shared/kagent-resources.js";
import { type AccessPlan, serverTargets } from "../governance/access-plans.js";
import type { KagentClients } from "../kagent/clients.js";
import { meta, resource } from "../kagent/resources.js";
import type { ResourceStore } from "./resources.js";

export const compiledTargets = (plans: JsonObject[]) =>
  serverTargets(plans as unknown as AccessPlan[]);

export const systemConnection = (value: JsonObject) =>
  object(meta(value).annotations)["agentos.dev/system-connection"] === "true";

function serviceBindings(
  name: string,
  plans: JsonObject[],
  servers: ToolServer[],
  namespace: string,
) {
  return [
    { server: name, identity: "catalog" },
    ...[...compiledTargets(plans).values()].filter(
      (target) => target.service === name && target.identity,
    ),
  ].map((target) =>
    create(MCPCredentialBindingSchema, {
      identity: target.identity,
      server:
        servers.find((server) => server.ref === `${namespace}/${target.server}`) ??
        create(ToolServerSchema, { ref: `${namespace}/${target.server}` }),
    }),
  );
}

/** Stored connections with their consumers, tools and native model configuration. */
export function connectionViews(store: ResourceStore, clients: KagentClients, namespace: string) {
  async function catalog() {
    const [templates, harnesses, modelConfigs, { toolServers }, backends, plans] =
      await Promise.all([
        store.list("templates"),
        store.list("harnesses"),
        store.list("modelConfigs"),
        clients.tools.listToolServers({}, { timeoutMs: 10_000 }),
        store.list("mcps"),
        store.list("accessPlans"),
      ]);
    return { templates, harnesses, modelConfigs, toolServers, backends, plans };
  }
  type Catalog = Awaited<ReturnType<typeof catalog>>;

  function modelConsumers(name: string, { templates, harnesses }: Catalog) {
    return [
      ...templates
        .filter((item) => object(object(item.spec).modelConfig).name === name)
        .map((item) => text(meta(item).name)),
      ...harnesses
        .filter(
          (item) =>
            object(object(object(object(item.spec).kagent).memory).modelConfigRef).name === name,
        )
        .map((item) => `harness:${text(meta(item).name)}`),
    ];
  }

  function serviceConsumers(name: string, context: Catalog) {
    const { templates, backends, toolServers, plans } = context;
    const bindings = backends.some((item) => meta(item).name === name)
      ? serviceBindings(name, plans, toolServers, namespace)
      : [];
    const usesService = (tool: JsonObject) => {
      const mcp = object(tool.mcp);
      const server = object(mcp.server).name;
      return (
        server === name ||
        (Array.isArray(mcp.tools) &&
          mcp.tools.length > 0 &&
          bindings.some((binding) => binding.server?.ref === `${namespace}/${server}`))
      );
    };
    return templates
      .filter((item) => {
        const tools = object(item.spec).tools;
        return Array.isArray(tools) && tools.some((tool) => usesService(object(tool)));
      })
      .map((item) => text(meta(item).name));
  }

  const uses = (kind: ConnectionKind, name: string, context: Catalog) =>
    kind === ConnectionKind.MODEL ? modelConsumers(name, context) : serviceConsumers(name, context);

  function nativeModel(kind: ConnectionKind, name: string, value: JsonObject, context: Catalog) {
    const desired = text(object(meta(value).annotations)["agentos.dev/model-config"]);
    const model = desired
      ? {
          apiVersion: kagentApiVersion,
          kind: "ModelConfig",
          metadata: { name, namespace },
          spec: JSON.parse(desired),
        }
      : kind === ConnectionKind.MODEL
        ? context.modelConfigs.find((item) => meta(item).name === name)
        : undefined;
    return model
      ? create(ModelConfigSchema, { ref: { namespace, name }, resource: resource(model) })
      : undefined;
  }

  function view(kind: ConnectionKind, value: JsonObject, context: Catalog): Connection {
    const name = text(meta(value).name);
    const isMcp = kind === ConnectionKind.MCP;
    const credentialBindings = isMcp
      ? serviceBindings(name, context.plans, context.toolServers, namespace)
      : [];
    const discovered = isMcp
      ? (context.toolServers.find((server) => server.ref === `${namespace}/${name}`)
          ?.discoveredTools ?? [])
      : [];
    const tools = [
      ...new Map(
        [
          ...discovered,
          ...credentialBindings.flatMap((binding) => binding.server?.discoveredTools ?? []),
        ].map((tool) => [tool.name, tool]),
      ).values(),
    ];
    return create(ConnectionSchema, {
      kind,
      resource: resource(value),
      usedBy: uses(kind, name, context),
      tools,
      credentialBindings,
      model: nativeModel(kind, name, value, context),
      systemManaged:
        systemConnection(value) || Boolean(compiledTargets(context.plans).get(name)?.environment),
    });
  }

  return { catalog, uses, view };
}
