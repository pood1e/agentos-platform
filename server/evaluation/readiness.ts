import { isDeepStrictEqual } from "node:util";
import type { JsonObject } from "@bufbuild/protobuf";
import { create } from "@bufbuild/protobuf";
import { AgentTemplateSchema } from "../../gen/kagent/api/v1/agent_templates_pb.js";
import { roleDefinition } from "../console/role-template.js";
import { meta } from "../management/native.js";
import type { ResourceStore } from "../management/resources.js";
import { object, text } from "../read-model/decode/messages.js";
import type { CandidateRecord } from "./store.js";

export function nativeReady(value: JsonObject) {
  const status = object(value.status),
    conditions = status.conditions;
  return (
    status.observedGeneration === meta(value).generation &&
    !!status.desiredRevision &&
    status.desiredRevision === status.latestSuccessfulRevision &&
    Array.isArray(conditions) &&
    conditions.some((entry) => object(entry).type === "Ready" && object(entry).status === "True")
  );
}

/** Dependency edits must produce a newly prepared native revision before new work is admitted. */
export function publicationReadiness(store: ResourceStore) {
  const comparable = (value: JsonObject) =>
    value.kind === "AgentTemplate"
      ? {
          ...object(value.spec),
          tools: roleDefinition(create(AgentTemplateSchema, { resource: { value } })).tools,
        }
      : value.spec;
  return async (record: CandidateRecord) => {
    const changed = record.snapshot.proposals.flatMap((proposal) => {
      const value = proposal.resource?.value;
      if (!value || proposal.delete) return [];
      const before = record.snapshot.resources.find(
        (entry) => entry.kind === value.kind && meta(entry.value ?? {}).name === meta(value).name,
      )?.value;
      return before && isDeepStrictEqual(comparable(before), comparable(value)) ? [] : [value];
    });
    const agents = await store.list("agents"),
      templates = await store.list("templates"),
      harnesses = await store.list("harnesses");
    for (const agent of agents) {
      const spec = object(agent.spec);
      const template = templates.find(
        (value) => meta(value).name === object(object(spec.template).ref).name,
      );
      const harness = harnesses.find((value) => meta(value).name === object(spec.harnessRef).name);
      const ts = object(template?.spec),
        hs = object(harness?.spec);
      const modelNames = [
        object(ts.modelConfig).name,
        object(object(object(hs.kagent).memory).modelConfigRef).name,
      ];
      const servers = (Array.isArray(ts.tools) ? ts.tools : []).map(
        (tool) => object(object(object(tool).mcp).server).name,
      );
      const affected = changed.some((value) => {
        const name = meta(value).name;
        return (
          (value.kind === "Agent" && name === meta(agent).name) ||
          (value.kind === "AgentTemplate" && name === meta(template ?? {}).name) ||
          (value.kind === "Harness" && name === meta(harness ?? {}).name) ||
          (value.kind === "ModelConfig" && modelNames.includes(name)) ||
          (value.kind === "RemoteMCPServer" && servers.includes(name))
        );
      });
      if (!affected) continue;
      const previous = record.snapshot.artifacts.find(
        (entry) =>
          entry.source ===
          `kagent-runtime://${record.snapshot.workspace}/${text(meta(agent).name)}`,
      );
      if (
        !nativeReady(agent) ||
        (previous && object(agent.status).desiredRevision === previous.version)
      )
        return false;
    }
    return true;
  };
}
