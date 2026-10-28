import { create, type JsonObject } from "@bufbuild/protobuf";
import {
  type Connection,
  ConnectionKind,
  ConnectionSchema,
  type ListConnectionsRequest,
  ModelPurpose,
  type SaveConnectionRequest,
} from "../../gen/agentos/management/v1/management_pb.js";
import { ModelConfigSchema } from "../../gen/kagent/api/v1/models_pb.js";
import { modelPurpose } from "../../shared/model-purpose.js";

const actorTokenHeader = "x-substrate-actor-token";

import type { KagentClients } from "../kagent/clients.js";
import { object, text } from "../read-model/decode/messages.js";
import { pageOf } from "../read-model/page.js";
import { conflict, invalid, precondition } from "../shared/errors.js";
import { compiledTargets, serviceBindings } from "./connection-views.js";
import { credentialReferences, type GatewayConfig, meta, optional, resource } from "./native.js";

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
  async function catalog() {
    const [templates, harnesses, modelConfigs, toolServers, backends, plans] = await Promise.all([
      store.list("templates"),
      store.list("harnesses"),
      store.list("modelConfigs"),
      clients.tools.listToolServers({}, { timeoutMs: 10_000 }),
      store.list("mcps"),
      store.list("accessPlans"),
    ]);
    return {
      templates,
      harnesses,
      modelConfigs,
      toolServers: toolServers.toolServers,
      backends,
      plans,
    };
  }
  function uses(kind: ConnectionKind, name: string, context: Awaited<ReturnType<typeof catalog>>) {
    const { templates, harnesses, backends, toolServers, plans } = context;
    const service = backends.find((item) => meta(item).name === name);
    const bindings =
      kind === ConnectionKind.MCP && service
        ? serviceBindings(service, plans, toolServers, gateway.namespace)
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
    const desiredModel = text(object(meta(value).annotations)["agentos.dev/model-config"]);
    const model = desiredModel
      ? {
          apiVersion: "api.kagent.dev/v1alpha3",
          kind: "ModelConfig",
          metadata: { name, namespace: gateway.namespace },
          spec: JSON.parse(desiredModel),
        }
      : kind === ConnectionKind.MODEL
        ? context.modelConfigs.find((item) => meta(item).name === name)
        : undefined;
    const credentialBindings =
      kind === ConnectionKind.MCP
        ? serviceBindings(value, context.plans, context.toolServers, gateway.namespace)
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
      systemManaged:
        object(meta(value).annotations)["agentos.dev/system-connection"] === "true" ||
        Boolean(compiledTargets(context.plans).get(name)?.environment),
    });
  }
  async function list(request: ListConnectionsRequest) {
    const context = await catalog();
    const targets = compiledTargets(context.plans);
    const query = request.query.toLowerCase().trim();
    const items = (await store.list(keyFor(request.kind)))
      .filter(
        (item) =>
          request.kind === ConnectionKind.MODEL ||
          (object(item.spec).mcp !== undefined &&
            !targets.get(text(meta(item).name))?.engineer &&
            object(meta(item).annotations)["agentos.dev/connection-role"] !== "ingress"),
      )
      .filter((item) =>
        `${meta(item).name} ${JSON.stringify(item.spec)}`.toLowerCase().includes(query),
      )
      .filter(
        (item) =>
          request.modelPurpose === ModelPurpose.UNSPECIFIED ||
          modelPurpose(item) === request.modelPurpose,
      )
      .sort((a, b) => text(meta(a).name).localeCompare(text(meta(b).name)));
    const page = pageOf(
      items,
      request,
      `management.connections:${request.kind}:${request.modelPurpose}`,
      (item) => ({
        id: text(meta(item).name),
        time: 0,
      }),
    );
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
      compiledTargets(await store.list("accessPlans")).get(name)?.environment
    )
      throw precondition("management.credentialBinding");
    if (current && object(meta(current).annotations)["agentos.dev/system-connection"] === "true")
      throw precondition("management.systemManaged");
    if (!request.create && !text(meta(value).resourceVersion))
      throw invalid("configuration.conflict");
    if (!request.create && meta(current ?? {}).resourceVersion !== meta(value).resourceVersion)
      throw conflict("configuration.conflict");
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
    if (kind === ConnectionKind.MCP) {
      const mcp = { ...object(policies.mcp) };
      delete mcp.authorization;
      policies.mcp = mcp;
      const transformation = object(policies.transformation);
      const request = object(transformation.request);
      policies.transformation = {
        ...transformation,
        request: {
          ...request,
          remove: [
            ...new Set([
              ...(Array.isArray(request.remove) ? request.remove : []),
              actorTokenHeader,
              "cookie",
              "x-forwarded-access-token",
            ]),
          ],
        },
      };
    } else {
      policies.authorization = {
        action: "Require",
        policy: {
          matchExpressions: [
            `!('x-substrate-actor-token' in request.headers) || extauthz.models.exists(m, m.name == ${JSON.stringify(name)})`,
          ],
        },
      };
      const headers = object(policies.headers),
        requestHeaders = object(headers.request);
      policies.headers = {
        ...headers,
        request: {
          ...requestHeaders,
          remove: [
            ...new Set([
              ...(Array.isArray(requestHeaders.remove) ? requestHeaders.remove : []),
              actorTokenHeader,
            ]),
          ],
        },
      };
    }

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
            "kagent.dev/connection": "true",
            ...(kind === ConnectionKind.MODEL && connection.model?.resource?.value?.spec
              ? { "agentos.dev/model-config": JSON.stringify(connection.model.resource.value.spec) }
              : {}),
          },
        },
        spec,
      },
      request.create,
    );
    if (request.credential?.trim())
      await store.credential(credentialName, request.credential.trim(), saved);
    return { connection: await view(kind, saved, await catalog()) };
  }

  async function remove(kind: ConnectionKind, name: string, version: string) {
    const current = await store.get(keyFor(kind), name);
    if (
      kind === ConnectionKind.MCP &&
      compiledTargets(await store.list("accessPlans")).get(name)?.environment
    )
      throw precondition("management.credentialBinding");
    if (object(meta(current).annotations)["agentos.dev/system-connection"] === "true")
      throw precondition("management.systemManaged");
    if (uses(kind, name, await catalog()).length) throw precondition("management.inUse");
    await store.remove(keyFor(kind), name, version);
    return {};
  }
  return { list, save, remove };
}
