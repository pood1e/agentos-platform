import { randomUUID } from "node:crypto";
import { create, type JsonObject } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { ResourceProposalSchema } from "../../gen/agentos/evaluation/v1/evaluation_pb.js";
import {
  CreateAgentTemplateResponseSchema,
  DeleteAgentTemplateResponseSchema,
} from "../../gen/kagent/api/v1/agent_templates_pb.js";
import { CreateAgentResponseSchema } from "../../gen/kagent/api/v1/agents_pb.js";
import { StructuredObjectSchema } from "../../gen/kagent/api/v1/common_pb.js";
import type { TemplateWriter } from "../console/template-writer.js";
import type { KagentClients } from "../kagent/clients.js";
import { meta, resource } from "../management/native.js";
import type { ResourceKind, ResourceStore } from "../management/resources.js";
import { text } from "../read-model/decode/messages.js";

/** Run the existing command validation against an overlay; no live write is performed. */
export function configurationDraft(source: ResourceStore, workspace: string, catalogName: string) {
  const changes = new Map<string, ReturnType<typeof create<typeof ResourceProposalSchema>>>();
  const key = (kind: string, name: string) => `${kind}/${name}`;
  function record(value: JsonObject, deleted = false) {
    const proposal = create(ResourceProposalSchema, {
      resource: create(StructuredObjectSchema, resource(value)),
      delete: deleted,
    });
    changes.set(key(text(value.kind), text(meta(value).name)), proposal);
    return value;
  }
  const staged = (kind: ResourceKind, name: string) =>
    [...changes.values()].find((proposal) => {
      const value = proposal.resource?.value;
      return value?.kind === nativeKind(kind) && meta(value).name === name;
    });
  let catalog: Awaited<ReturnType<ResourceStore["readCatalog"]>> | undefined;
  const store: ResourceStore = {
    ...source,
    async list(kind) {
      const values = new Map(
        (await source.list(kind)).map((value) => [text(meta(value).name), value]),
      );
      for (const proposal of changes.values()) {
        const value = proposal.resource?.value;
        if (!value || value.kind !== nativeKind(kind)) continue;
        if (proposal.delete) values.delete(text(meta(value).name));
        else values.set(text(meta(value).name), value);
      }
      return [...values.values()];
    },
    async get(kind, name) {
      const proposal = staged(kind, name);
      if (!proposal) return source.get(kind, name);
      if (proposal.delete || !proposal.resource?.value)
        throw new ConnectError("Resource is removed in this candidate", Code.NotFound);
      return proposal.resource.value;
    },
    async save(kind, value, isNew) {
      const name = text(meta(value).name);
      if (!name || (meta(value).namespace && meta(value).namespace !== workspace))
        throw new ConnectError(
          "Candidate resource belongs to another workspace",
          Code.InvalidArgument,
        );
      const prior = staged(kind, name);
      if (!prior) await source.validate(kind, value, isNew);
      return record({
        ...value,
        metadata: {
          ...meta(value),
          namespace: workspace,
          uid: meta(value).uid || randomUUID(),
          resourceVersion: meta(value).resourceVersion || "candidate",
        },
      });
    },
    async remove(kind, name, version) {
      const current = await store.get(kind, name);
      if (meta(current).resourceVersion !== version)
        throw new ConnectError("Resource changed during editing", Code.Aborted);
      record(current, true);
    },
    async readCatalog() {
      return catalog ?? source.readCatalog();
    },
    async writeCatalog(value, version) {
      const current = await store.readCatalog();
      if (current.version !== version)
        throw new ConnectError("Skill catalog changed", Code.Aborted);
      catalog = { value, version };
      record({
        apiVersion: "v1",
        kind: "ConfigMap",
        metadata: { name: catalogName, namespace: workspace, resourceVersion: version },
        data: { "catalog.json": value },
      });
      return version;
    },
    async credential(name, value, owner) {
      record({
        apiVersion: "v1",
        kind: "Secret",
        type: "Opaque",
        metadata: {
          name,
          namespace: workspace,
          ownerReferences: [
            {
              apiVersion: owner.apiVersion,
              kind: owner.kind,
              name: meta(owner).name,
              uid: meta(owner).uid,
            },
          ],
        },
        stringData: { Authorization: value },
      });
    },
  };
  function clients(native: KagentClients): KagentClients {
    return {
      ...native,
      templates: {
        ...native.templates,
        async createAgentTemplate(request) {
          if (!request.resource?.value)
            throw new ConnectError("Template is required", Code.InvalidArgument);
          const value = await store.save("templates", request.resource.value, true);
          return create(CreateAgentTemplateResponseSchema, {
            agentTemplate: { ref: request.ref, resource: resource(value) },
          });
        },
        async deleteAgentTemplate(request) {
          const value = await store.get("templates", request.ref?.name ?? "");
          await store.remove(
            "templates",
            request.ref?.name ?? "",
            text(meta(value).resourceVersion),
          );
          return create(DeleteAgentTemplateResponseSchema);
        },
      },
      agents: {
        ...native.agents,
        async createAgent(request) {
          if (!request.resource?.value)
            throw new ConnectError("Engineer is required", Code.InvalidArgument);
          const value = await store.save("agents", request.resource.value, true);
          return create(CreateAgentResponseSchema, {
            agent: { ref: request.ref, resource: resource(value) },
          });
        },
      },
    };
  }
  const replace: TemplateWriter = async (template) => ({
    ...template,
    resource: template.resource
      ? {
          ...template.resource,
          value: await store.save("templates", template.resource.value ?? {}, false),
        }
      : undefined,
  });
  return { store, clients, replace, proposals: () => [...changes.values()] };
}

export function nativeKind(kind: ResourceKind): string {
  return {
    models: "AgentgatewayModel",
    mcps: "AgentgatewayBackend",
    mcpPolicies: "AgentgatewayPolicy",
    routes: "HTTPRoute",
    templates: "AgentTemplate",
    agents: "Agent",
    harnesses: "Harness",
    modelConfigs: "ModelConfig",
    remoteMCPs: "RemoteMCPServer",
  }[kind];
}
