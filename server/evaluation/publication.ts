import { isDeepStrictEqual } from "node:util";
import type { JsonObject } from "@bufbuild/protobuf";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { CoreV1Api, type KubeConfig } from "@kubernetes/client-node";
import { Mutex } from "async-mutex";
import {
  CandidateState,
  type ResourceProposal,
} from "../../gen/agentos/evaluation/v1/evaluation_pb.js";
import { AgentTemplateSchema } from "../../gen/kagent/api/v1alpha1/agent_templates_pb.js";
import { roleDefinition, templateSpec } from "../console/role-template.js";
import type { KagentClients } from "../kagent/clients.js";
import { meta, optional } from "../management/native.js";
import { type ResourceKind, type ResourceStore, resourceKinds } from "../management/resources.js";
import type { machineIdentities } from "../platform/machine-identities.js";
import { object, text } from "../read-model/decode/messages.js";
import { nativeKind } from "./draft.js";
import { secretArtifact } from "./references.js";
import { configurationResource } from "./snapshot.js";
import type { CandidateRecord, EvaluationStore } from "./store.js";

const identity = (value: JsonObject) => `${value.kind}/${meta(value).name}`;
const kindFor = (value: JsonObject) =>
  (Object.keys(resourceKinds) as ResourceKind[]).find((kind) => nativeKind(kind) === value.kind);
const unchanged = (current: JsonObject, frozen: JsonObject) =>
  isDeepStrictEqual(configurationResource(current), configurationResource(frozen));
function denied(message: string): never {
  throw new ConnectError(message, Code.FailedPrecondition);
}

export function publications(
  config: KubeConfig,
  store: ResourceStore,
  candidates: EvaluationStore,
  workspace: string,
  catalogName: string,
  bind: ReturnType<typeof machineIdentities>["bind"],
) {
  const core = config.makeApiClient(CoreV1Api);
  const mutex = new Mutex();
  let blocked = false;
  async function refresh() {
    blocked = (await candidates.list()).some((item) => item.state === CandidateState.PUBLISHING);
  }
  async function available() {
    await refresh();
    if (blocked) denied("Configuration publication is incomplete; new sessions are paused");
  }
  function clients(native: KagentClients): KagentClients {
    return {
      ...native,
      sessions: {
        ...native.sessions,
        createSession: (request, options) =>
          mutex.runExclusive(async () => {
            if (request.agent?.namespace === workspace) await available();
            return native.sessions.createSession(request, options);
          }),
      },
    };
  }
  async function validate(proposals: ResourceProposal[]) {
    const seen = new Set<string>();
    for (const proposal of proposals) {
      const value = proposal.resource?.value;
      if (
        !value ||
        value.kind !== proposal.resource?.kind ||
        value.apiVersion !== proposal.resource?.apiVersion ||
        !/^[a-z0-9][a-z0-9.-]{0,252}$/.test(text(meta(value).name)) ||
        meta(value).namespace !== workspace ||
        seen.has(identity(value))
      )
        denied("Candidate contains an invalid or duplicate native resource");
      seen.add(identity(value));
      if (value.kind === "Secret") {
        if (
          proposal.delete ||
          value.apiVersion !== "v1" ||
          !/^agentos-(?:model|mcp)-/.test(text(meta(value).name))
        )
          denied("Only connection-owned credentials can be proposed");
        const owners = meta(value).ownerReferences;
        if (!Array.isArray(owners) || owners.length !== 1) denied("Credential owner is required");
        const owner = object(owners[0]);
        if (
          !proposals.some(
            (item) =>
              item.resource?.value?.kind === owner.kind &&
              meta(item.resource.value).name === owner.name &&
              ["AgentgatewayModel", "AgentgatewayBackend"].includes(text(owner.kind)),
          )
        )
          denied("Credential must belong to a connection in this candidate");
        continue;
      }
      if (value.kind === "ConfigMap") {
        if (
          proposal.delete ||
          value.apiVersion !== "v1" ||
          meta(value).name !== catalogName ||
          typeof object(value.data)["catalog.json"] !== "string"
        )
          denied("Only the native skill catalog can be proposed");
        continue;
      }
      const kind = kindFor(value);
      if (!kind) denied("Unsupported configuration resource");
      const [group, version] = resourceKinds[kind];
      if (value.apiVersion !== `${group}/${version}`) denied("Native resource API version differs");
      const current = await optional(store, kind, text(meta(value).name));
      if (
        current &&
        (meta(value).uid !== meta(current).uid ||
          meta(value).generation !== meta(current).generation)
      )
        denied("Configuration changed during editing");
      if (!proposal.delete) await store.validate(kind, clean(value, current), !current);
    }
  }
  function clean(value: JsonObject, current?: JsonObject): JsonObject {
    const metadata: JsonObject = { ...meta(value), namespace: workspace };
    delete metadata.uid;
    delete metadata.generation;
    delete metadata.creationTimestamp;
    delete metadata.managedFields;
    if (current) metadata.resourceVersion = meta(current).resourceVersion ?? "";
    else delete metadata.resourceVersion;
    const result: JsonObject = { ...value, metadata };
    delete result.status;
    return result;
  }
  async function publish(record: CandidateRecord) {
    blocked = true;
    return mutex.runExclusive(async () => {
      const proposed = new Map(
        record.snapshot.proposals.flatMap((item) =>
          item.resource?.value ? [[identity(item.resource.value), item] as const] : [],
        ),
      );
      // Status-only updates do not invalidate the candidate. Unrelated configuration changes do.
      for (const entry of record.snapshot.resources) {
        const value = entry.value;
        if (!value || proposed.has(identity(value))) continue;
        const kind = kindFor(value);
        if (kind) {
          const current = await store.get(kind, text(meta(value).name));
          if (!unchanged(current, value))
            denied("Unrelated configuration changed before publication");
        } else if (value.kind === "ConfigMap") {
          if ((await store.readCatalog()).value !== object(value.data)["catalog.json"])
            denied("Skill catalog changed before publication");
        }
      }
      for (const artifact of record.snapshot.artifacts.filter((entry) =>
        entry.source.startsWith("k8s-secret://"),
      )) {
        const name = new URL(artifact.source).pathname.slice(1);
        if (proposed.has(`Secret/${name}`)) continue;
        const current = secretArtifact(
          await core.readNamespacedSecret({ namespace: workspace, name }),
        );
        if (current.sha256 !== artifact.sha256 || current.version !== artifact.version)
          denied("A bound credential changed before publication");
      }
      const ordered = [...proposed.values()].sort(
        (a, b) => priority(a.resource?.kind) - priority(b.resource?.kind),
      );
      for (const proposal of ordered) {
        let value = proposal.resource?.value;
        if (!value) denied("Candidate resource is missing");
        const name = text(meta(value).name);
        if (value.kind === "AgentTemplate" && !proposal.delete) {
          const role = roleDefinition(
            create(AgentTemplateSchema, {
              ref: { namespace: workspace, name },
              resource: proposal.resource,
            }),
          );
          value = {
            ...value,
            spec: templateSpec(
              { ...role, tools: await bind(name, role.tools) },
              object(value.spec),
            ),
          };
        }
        if (value.kind === "ConfigMap") {
          const current = await store.readCatalog();
          const frozen = record.snapshot.resources.find(
            (entry) => entry.value && identity(entry.value) === identity(value),
          )?.value;
          const target = text(object(value.data)["catalog.json"]);
          if (current.value === target) continue;
          if (!frozen || current.value !== object(frozen.data)["catalog.json"])
            denied("Skill catalog changed before publication");
          await store.writeCatalog(target, current.version);
          continue;
        }
        if (value.kind === "Secret") {
          const owner = object((meta(value).ownerReferences as JsonObject[])[0]);
          const kind = kindFor(owner);
          if (!kind) denied("Credential owner kind is invalid");
          const current = await store.get(kind, text(owner.name));
          await store.credential(name, text(object(value.stringData).Authorization), current);
          continue;
        }
        const kind = kindFor(value);
        if (!kind) denied("Unsupported configuration resource");
        const current = await optional(store, kind, name);
        const original = record.snapshot.resources.find(
          (entry) => entry.value && identity(entry.value) === identity(value),
        )?.value;
        if (!current && proposal.delete) continue;
        if (
          current &&
          !proposal.delete &&
          isDeepStrictEqual(current.spec, value.spec) &&
          isDeepStrictEqual(meta(current).annotations ?? {}, meta(value).annotations ?? {}) &&
          isDeepStrictEqual(meta(current).labels ?? {}, meta(value).labels ?? {})
        )
          continue;
        if (current && (!original || !unchanged(current, original)))
          denied("Configuration changed before publication");
        if (!current && original) denied("Configuration was removed before publication");
        if (proposal.delete)
          await store.remove(kind, name, text(meta(current ?? {}).resourceVersion));
        else await store.save(kind, clean(value, current), !current);
      }
    });
  }
  return { validate, publish, clients, available, refresh, ready: () => !blocked };
}

function priority(kind?: string) {
  return [
    "Harness",
    "AgentgatewayModel",
    "AgentgatewayBackend",
    "AgentgatewayPolicy",
    "Secret",
    "HTTPRoute",
    "ModelConfig",
    "RemoteMCPServer",
    "ConfigMap",
    "AgentTemplate",
    "Agent",
  ].indexOf(kind ?? "");
}
