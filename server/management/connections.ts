import { create, type JsonObject } from "@bufbuild/protobuf";
import {
  type Connection,
  ConnectionKind,
  ConnectionSchema,
  type ListConnectionsRequest,
  type SaveConnectionRequest,
} from "../../gen/agentos/management/v1/management_pb.js";
import { ModelConfigSchema } from "../../gen/kagent/api/v1alpha1/models_pb.js";
import type { KagentClients } from "../kagent/clients.js";
import { object, text } from "../read-model/decode/messages.js";
import { pageOf } from "../read-model/page.js";
import { conflict, invalid, precondition } from "../shared/errors.js";
import { connectionBindings } from "./bindings.js";
import { credentialReferences } from "./credential-references.js";
import { credentialProfile, refreshCredentialProfiles, serviceBindings } from "./mcp-services.js";
import { type GatewayConfig, meta, optional, resource } from "./native.js";

export type { GatewayConfig } from "./native.js";

import type { ResourceKind, ResourceStore } from "./resources.js";

const keyFor = (kind: ConnectionKind): ResourceKind =>
  kind === ConnectionKind.MODEL ? "models" : "mcps";
const nativeKind = (kind: ConnectionKind) =>
  kind === ConnectionKind.MODEL ? "AgentgatewayModel" : "AgentgatewayBackend";
export function connectionCommands(
  store: ResourceStore,
  clients: KagentClients,
  gateway: GatewayConfig,
) {
  const { bindModel, bindMCP } = connectionBindings(store, gateway);
  async function catalog() {
    const [templates, harnesses, modelConfigs, toolServers, backends] = await Promise.all([
      store.list("templates"),
      store.list("harnesses"),
      store.list("modelConfigs"),
      clients.tools.listToolServers({}, { timeoutMs: 10_000 }),
      store.list("mcps"),
    ]);
    return { templates, harnesses, modelConfigs, toolServers: toolServers.toolServers, backends };
  }
  function uses(kind: ConnectionKind, name: string, context: Awaited<ReturnType<typeof catalog>>) {
    const { templates, harnesses, backends, toolServers } = context;
    const service = backends.find((item) => meta(item).name === name);
    const bindings =
      kind === ConnectionKind.MCP && service
        ? serviceBindings(service, backends, toolServers, gateway.namespace)
        : [];
    const roles = templates
      .filter((item) => {
        const spec = object(item.spec);
        return kind === ConnectionKind.MODEL
          ? object(spec.modelConfig).name === name
          : (Array.isArray(spec.tools) ? spec.tools : []).some((tool) => {
              const mcp = object(object(tool).mcp);
              const server = object(mcp.server).name;
              return (
                server === name ||
                bindings.some(
                  (binding) =>
                    binding.server?.ref === `${gateway.namespace}/${server}` &&
                    Array.isArray(mcp.tools) &&
                    mcp.tools.length > 0,
                )
              );
            });
      })
      .map((item) => text(meta(item).name));
    if (kind === ConnectionKind.MODEL)
      for (const harness of harnesses)
        if (object(object(object(object(harness.spec).kagent).memory).modelConfigRef).name === name)
          roles.push(`harness:${text(meta(harness).name)}`);
    return roles;
  }
  async function view(
    kind: ConnectionKind,
    value: JsonObject,
    context: Awaited<ReturnType<typeof catalog>>,
  ): Promise<Connection> {
    const name = text(meta(value).name);
    const usedBy = uses(kind, name, context);
    const model =
      kind === ConnectionKind.MODEL
        ? context.modelConfigs.find((item) => meta(item).name === name)
        : undefined;
    const credentialBindings =
      kind === ConnectionKind.MCP
        ? serviceBindings(value, context.backends, context.toolServers, gateway.namespace)
        : [];
    const discovered =
      kind === ConnectionKind.MCP
        ? (context.toolServers.find((server) => server.ref === `${gateway.namespace}/${name}`)
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
      usedBy,
      tools,
      credentialBindings,
      model: model
        ? create(ModelConfigSchema, {
            ref: { namespace: gateway.namespace, name },
            resource: resource(model),
          })
        : undefined,
      systemManaged: object(meta(value).annotations)["agentos.dev/system-connection"] === "true",
    });
  }
  async function list(request: ListConnectionsRequest) {
    const query = request.query.toLowerCase().trim();
    const items = (await store.list(keyFor(request.kind)))
      .filter(
        (item) =>
          request.kind === ConnectionKind.MODEL ||
          (object(item.spec).mcp !== undefined && !credentialProfile(item)),
      )
      .filter((item) =>
        `${meta(item).name} ${JSON.stringify(item.spec)}`.toLowerCase().includes(query),
      )
      .sort((a, b) => text(meta(a).name).localeCompare(text(meta(b).name)));
    const page = pageOf(items, request, `management.connections:${request.kind}`, (item) => ({
      id: text(meta(item).name),
      time: 0,
    }));
    const context = await catalog();
    const connections = await Promise.all(
      page.items.map((item) => view(request.kind, item, context)),
    );
    return { connections, nextPageToken: page.nextPageToken, totalSize: page.totalSize };
  }
  async function save(request: SaveConnectionRequest) {
    const connection = request.connection;
    const value = connection?.resource?.value;
    if (!connection || !value || !text(meta(value).name)) throw invalid("management.invalid");
    const kind = connection.kind;
    const name = text(meta(value).name);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 63)
      throw invalid("management.invalid");
    if (value.kind !== nativeKind(kind) || value.apiVersion !== "agentgateway.dev/v1alpha1")
      throw invalid("management.invalid");
    if (meta(value).namespace && meta(value).namespace !== gateway.namespace)
      throw invalid("management.wrongNamespace");
    const current = await optional(store, keyFor(kind), name);
    if (
      kind === ConnectionKind.MCP &&
      (credentialProfile(current ?? {}) || credentialProfile(value))
    )
      throw precondition("management.credentialBinding");
    if (current && object(meta(current).annotations)["agentos.dev/system-connection"] === "true")
      throw precondition("management.systemManaged");
    if (!request.create && !text(meta(value).resourceVersion))
      throw invalid("configuration.conflict");
    if (!request.create && meta(current ?? {}).resourceVersion !== meta(value).resourceVersion)
      throw conflict("configuration.conflict");
    if (request.create) {
      for (const [childKind, childName] of (kind === ConnectionKind.MODEL
        ? [["modelConfigs", name]]
        : [
            ["remoteMCPs", name],
            ["routes", `mcp-${name}`],
          ]) as [ResourceKind, string][]) {
        if (await optional(store, childKind, childName)) throw precondition("management.nameInUse");
      }
    }
    const spec = { ...object(value.spec) };
    if (kind === ConnectionKind.MODEL && text(object(spec.match).model).includes("*"))
      throw invalid("management.concreteModelRequired");
    if (kind === ConnectionKind.MODEL)
      spec.parentRefs = [
        {
          group: "gateway.networking.k8s.io",
          kind: "Gateway",
          name: gateway.name,
          sectionName: "http",
        },
      ];
    else {
      const mcp = { ...object(spec.mcp), prefixMode: object(spec.mcp).prefixMode ?? "Never" };
      const targets = object(spec.mcp).targets;
      if (!Array.isArray(targets) || targets.length !== 1) throw invalid("management.singleMCP");
      if (Array.isArray(targets))
        for (const target of targets) {
          const backend = object(object(target).static);
          if (!Object.keys(backend).length) continue;
          const policies = object(backend.policies);
          const http = object(policies.http);
          backend.policies = { ...policies, http: { requestTimeout: "10m", ...http } };
        }
      spec.mcp = mcp;
    }
    const policies = { ...object(spec.policies) };
    if (object(policies.auth).key !== undefined)
      throw invalid("management.secretReferenceRequired");
    const credentialName = `agentos-${kind === ConnectionKind.MODEL ? "model" : "mcp"}-${name}`;
    if (request.credential?.trim())
      policies.auth = {
        ...object(policies.auth),
        secretRef: { name: credentialName },
      };
    if (Object.keys(policies).length) spec.policies = policies;
    else delete spec.policies;
    credentialReferences(
      spec,
      current?.spec,
      request.credential?.trim()
        ? {
            path: "/policies/auth/secretRef",
            reference: { name: credentialName },
          }
        : undefined,
    );
    const saved = await store.save(
      keyFor(kind),
      {
        ...value,
        metadata: {
          ...meta(value),
          annotations: {
            ...object(meta(value).annotations),
            "agentos.dev/system-connection": "false",
          },
        },
        spec,
      },
      request.create,
    );
    try {
      if (request.credential?.trim())
        await store.credential(credentialName, request.credential.trim(), saved);
      if (kind === ConnectionKind.MODEL) await bindModel(saved, connection);
      else {
        await bindMCP(saved);
        await refreshCredentialProfiles(store, saved);
      }
    } catch (error) {
      if (request.create) {
        const latest = await optional(store, keyFor(kind), name);
        if (latest && meta(latest).resourceVersion === meta(saved).resourceVersion)
          await store.remove(keyFor(kind), name, text(meta(saved).resourceVersion));
      }
      throw error;
    }
    return { connection: await view(kind, await store.get(keyFor(kind), name), await catalog()) };
  }
  async function remove(kind: ConnectionKind, name: string, version: string) {
    const current = await store.get(keyFor(kind), name);
    if (kind === ConnectionKind.MCP && credentialProfile(current))
      throw precondition("management.credentialBinding");
    if (object(meta(current).annotations)["agentos.dev/system-connection"] === "true")
      throw precondition("management.systemManaged");
    if (uses(kind, name, await catalog()).length) throw precondition("management.inUse");
    await store.remove(keyFor(kind), name, version);
    return {};
  }
  return { list, save, remove };
}
