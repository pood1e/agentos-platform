import type { JsonObject } from "@bufbuild/protobuf";
import {
  ConnectionKind,
  type ListConnectionsRequest,
  ModelPurpose,
  type SaveConnectionRequest,
} from "../../gen/agentos/management/v1/management_pb.js";
import { object, text } from "../../shared/json.js";
import { modelPurpose } from "../../shared/model-purpose.js";
import type { KagentClients } from "../kagent/clients.js";
import { meta } from "../kagent/resources.js";
import { conflict, invalid, precondition, unlessMissing } from "../shared/errors.js";
import { pageOf } from "../shared/page.js";
import { connectionSpec } from "./connection-spec.js";
import { compiledTargets, connectionViews, systemConnection } from "./connection-views.js";
import { credentialReferences } from "./native.js";
import type { ResourceKind, ResourceStore } from "./resources.js";

const storeKind = (kind: ConnectionKind): ResourceKind =>
  kind === ConnectionKind.MODEL ? "models" : "mcps";
const nativeKind = (kind: ConnectionKind) =>
  kind === ConnectionKind.MODEL ? "AgentgatewayModel" : "AgentgatewayBackend";

export function connectionCommands(
  store: ResourceStore,
  clients: KagentClients,
  namespace: string,
  gatewayName: string,
) {
  const views = connectionViews(store, clients, namespace);

  /** Compiled environment services and chart-owned connections are read-only. */
  async function assertEditable(kind: ConnectionKind, name: string, current?: JsonObject) {
    if (
      kind === ConnectionKind.MCP &&
      compiledTargets(await store.list("accessPlans")).get(name)?.environment
    )
      throw precondition("management.credentialBinding");
    if (current && systemConnection(current)) throw precondition("management.systemManaged");
  }

  async function list(request: ListConnectionsRequest) {
    const context = await views.catalog();
    const targets = compiledTargets(context.plans);
    const query = request.query.toLowerCase().trim();
    const items = (await store.list(storeKind(request.kind)))
      .filter(
        (item) =>
          request.kind === ConnectionKind.MODEL ||
          (object(item.spec).mcp !== undefined &&
            !targets.get(text(meta(item).name))?.identity &&
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
      (item) => ({ id: text(meta(item).name), time: 0 }),
    );
    return {
      connections: page.items.map((item) => views.view(request.kind, item, context)),
      nextPageToken: page.nextPageToken,
      totalSize: page.totalSize,
    };
  }

  /** A submitted credential is stored in a Secret owned by the connection and only referenced. */
  function withCredential(
    kind: ConnectionKind,
    name: string,
    spec: JsonObject,
    previous: JsonObject | undefined,
    credential: string,
  ) {
    const policies = object(spec.policies);
    if (object(policies.auth).key !== undefined)
      throw invalid("management.secretReferenceRequired");
    const secretName = `agentos-${kind === ConnectionKind.MODEL ? "model" : "mcp"}-${name}`;
    const secured: JsonObject = credential
      ? {
          ...spec,
          policies: {
            ...policies,
            auth: { ...object(policies.auth), secretRef: { name: secretName } },
          },
        }
      : spec;
    credentialReferences(
      secured,
      previous,
      credential
        ? { path: "/policies/auth/secretRef", reference: { name: secretName } }
        : undefined,
    );
    return { spec: secured, secretName };
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
    if (meta(value).namespace && meta(value).namespace !== namespace)
      throw invalid("management.wrongNamespace");
    const current = await unlessMissing(store.get(storeKind(kind), name));
    await assertEditable(kind, name, current);
    if (!request.create && !text(meta(value).resourceVersion))
      throw invalid("configuration.conflict");
    if (!request.create && meta(current ?? {}).resourceVersion !== meta(value).resourceVersion)
      throw conflict("configuration.conflict");
    const credential = request.credential?.trim() ?? "";
    const { spec, secretName } = withCredential(
      kind,
      name,
      connectionSpec(kind, name, object(value.spec), gatewayName),
      object(current?.spec),
      credential,
    );
    const modelConfig = kind === ConnectionKind.MODEL && connection.model?.resource?.value?.spec;
    const saved = await store.save(
      storeKind(kind),
      {
        ...value,
        metadata: {
          ...meta(value),
          annotations: {
            ...object(meta(value).annotations),
            "agentos.dev/system-connection": "false",
            "kagent.dev/connection": "true",
            ...(modelConfig ? { "agentos.dev/model-config": JSON.stringify(modelConfig) } : {}),
          },
        },
        spec,
      },
      request.create,
    );
    if (credential) await store.credential(secretName, credential, saved);
    return { connection: views.view(kind, saved, await views.catalog()) };
  }

  async function remove(kind: ConnectionKind, name: string, version: string) {
    await assertEditable(kind, name, await store.get(storeKind(kind), name));
    if (views.uses(kind, name, await views.catalog()).length)
      throw precondition("management.inUse");
    await store.remove(storeKind(kind), name, version);
    return {};
  }

  return { list, save, remove };
}
