import type { JsonObject } from "@bufbuild/protobuf";
import { object } from "../../shared/json.js";
import { listNativeAgents, listNativeTemplates } from "../kagent/catalog.js";
import type { KagentClients } from "../kagent/clients.js";
import { userResource } from "../kagent/resources.js";

interface Native {
  resource?: { value?: JsonObject };
}
type NativeRef = { namespace: string; name: string };
interface WriteRequest {
  ref: NativeRef;
  resource: { apiVersion: string; kind: string; value: JsonObject };
}

/** kagent-owned kinds go through native RPCs so that its admission and ownership rules apply. */
export function kagentResources(clients: KagentClients, namespace: string) {
  const operations = <T extends Native>(
    kind: string,
    native: {
      get(ref: NativeRef): Promise<T | undefined>;
      list(): Promise<T[]>;
      create(request: WriteRequest): Promise<T | undefined>;
      update(request: WriteRequest): Promise<T | undefined>;
      remove(ref: NativeRef, resourceVersion: string): Promise<unknown>;
    },
  ) => ({
    read: async (name: string) => (await native.get({ namespace, name }))?.resource?.value,
    list: async () => (await native.list()).map((item) => item.resource?.value ?? {}),
    save: async (resource: JsonObject, create: boolean) => {
      const request = {
        ref: { namespace, name: String(object(resource.metadata).name) },
        resource: {
          apiVersion: String(resource.apiVersion),
          kind,
          value: userResource(resource),
        },
      };
      const saved = await (create ? native.create(request) : native.update(request));
      return saved?.resource?.value;
    },
    remove: async (name: string, resourceVersion: string) => {
      await native.remove({ namespace, name }, resourceVersion);
    },
  });
  const { agents, templates, harnesses } = clients;
  const kinds = {
    agents: operations("Agent", {
      get: async (ref) => (await agents.getAgent({ ref })).agent,
      list: () => listNativeAgents(clients, namespace),
      create: async (request) => (await agents.createAgent(request)).agent,
      update: async (request) => (await agents.updateAgent(request)).agent,
      remove: (ref, resourceVersion) => agents.deleteAgent({ ref, resourceVersion }),
    }),
    templates: operations("AgentTemplate", {
      get: async (ref) => (await templates.getAgentTemplate({ ref })).agentTemplate,
      list: () => listNativeTemplates(clients, namespace),
      create: async (request) => (await templates.createAgentTemplate(request)).agentTemplate,
      update: async (request) => (await templates.updateAgentTemplate(request)).agentTemplate,
      remove: (ref, resourceVersion) => templates.deleteAgentTemplate({ ref, resourceVersion }),
    }),
    harnesses: operations("Harness", {
      get: async (ref) => (await harnesses.getHarness({ ref })).harness,
      list: async () => (await harnesses.listHarnesses({ namespace })).harnesses,
      create: async (request) => (await harnesses.createHarness(request)).harness,
      update: async (request) => (await harnesses.updateHarness(request)).harness,
      remove: (ref, resourceVersion) => harnesses.deleteHarness({ ref, resourceVersion }),
    }),
  };
  return (kind: string) => kinds[kind as keyof typeof kinds];
}
