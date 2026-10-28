import type { JsonObject } from "@bufbuild/protobuf";
import type { KagentClients } from "../kagent/clients.js";
import { object } from "../read-model/decode/messages.js";
import { userResource } from "./native.js";

export function kagentResources(clients: KagentClients, namespace: string) {
  const operations = {
    agents: {
      read: async (name: string) =>
        (await clients.agents.getAgent({ ref: { namespace, name } })).agent?.resource?.value,
      list: async () =>
        (await clients.agents.listAgents({ namespace })).agents.map(
          (item) => item.resource?.value ?? {},
        ),
      save: async (resource: JsonObject, create: boolean) =>
        (
          await clients.agents[create ? "createAgent" : "updateAgent"]({
            ref: { namespace, name: String(object(resource.metadata).name) },
            resource: {
              apiVersion: String(resource.apiVersion),
              kind: "Agent",
              value: userResource(resource),
            },
          })
        ).agent?.resource?.value,
      remove: async (name: string, resourceVersion: string) => {
        await clients.agents.deleteAgent({ ref: { namespace, name }, resourceVersion });
      },
    },
    templates: {
      read: async (name: string) =>
        (await clients.templates.getAgentTemplate({ ref: { namespace, name } })).agentTemplate
          ?.resource?.value,
      list: async () =>
        (await clients.templates.listAgentTemplates({ namespace })).agentTemplates.map(
          (item) => item.resource?.value ?? {},
        ),
      save: async (resource: JsonObject, create: boolean) =>
        (
          await clients.templates[create ? "createAgentTemplate" : "updateAgentTemplate"]({
            ref: { namespace, name: String(object(resource.metadata).name) },
            resource: {
              apiVersion: String(resource.apiVersion),
              kind: "AgentTemplate",
              value: userResource(resource),
            },
          })
        ).agentTemplate?.resource?.value,
      remove: async (name: string, resourceVersion: string) => {
        await clients.templates.deleteAgentTemplate({ ref: { namespace, name }, resourceVersion });
      },
    },
    harnesses: {
      read: async (name: string) =>
        (await clients.harnesses.getHarness({ ref: { namespace, name } })).harness?.resource?.value,
      list: async () =>
        (await clients.harnesses.listHarnesses({ namespace })).harnesses.map(
          (item) => item.resource?.value ?? {},
        ),
      save: async (resource: JsonObject, create: boolean) =>
        (
          await clients.harnesses[create ? "createHarness" : "updateHarness"]({
            ref: { namespace, name: String(object(resource.metadata).name) },
            resource: {
              apiVersion: String(resource.apiVersion),
              kind: "Harness",
              value: userResource(resource),
            },
          })
        ).harness?.resource?.value,
      remove: async (name: string, resourceVersion: string) => {
        await clients.harnesses.deleteHarness({ ref: { namespace, name }, resourceVersion });
      },
    },
  };
  return (kind: string) => operations[kind as keyof typeof operations];
}
