import type { ServiceImpl } from "@connectrpc/connect";
import type { OperationsConfig } from "../../gen/agentos/governance/v1/change_pb.js";
import type { ManagementService } from "../../gen/agentos/management/v1/management_pb.js";
import mcpSchema from "../../gen/schema/agentgateway.mcp.json" with { type: "json" };
import modelSchema from "../../gen/schema/agentgateway.model.json" with { type: "json" };
import harnessSchema from "../../gen/schema/kagent.harness.json" with { type: "json" };
import type { KagentClients } from "../kagent/clients.js";
import { type KnowledgeConfig, knowledgeService } from "../knowledge/service.js";
import { connectionCommands, type GatewayConfig } from "./connections.js";
import { engineerRuntime } from "./engineer-runtime.js";
import { harnessCommands } from "./harnesses.js";
import type { ResourceStore } from "./resources.js";
import { skillCommands } from "./skills.js";

export interface ManagementDependencies {
  store: ResourceStore;
  clients: KagentClients;
  gateway: GatewayConfig;
  knowledge: KnowledgeConfig;
  operations: OperationsConfig;
}

export function managementService({
  store,
  clients,
  gateway,
  knowledge,
  operations,
}: ManagementDependencies): ServiceImpl<typeof ManagementService> {
  const connections = connectionCommands(store, clients, gateway);
  const skills = skillCommands(store, clients, gateway.namespace);
  const memories = knowledgeService(clients, knowledge);
  const harnesses = harnessCommands(store, gateway.namespace);
  const runtime = engineerRuntime(store, clients, gateway.namespace);
  return {
    getSchemas: () => ({
      model: modelSchema,
      mcp: mcpSchema,
      harness: harnessSchema,
    }),
    listConnections: (request) => connections.list(request),
    saveConnection: (request) => connections.save(request),
    deleteConnection: (request) =>
      connections.remove(request.kind, request.name, request.resourceVersion),
    listSkills: (request) => skills.list(request),
    saveSkill: (request) => skills.save(request),
    deleteSkill: (request) => skills.remove(request.name, request.resourceVersion),
    listKnowledge: (request) => memories.list(request),
    searchKnowledge: async (request) => ({
      memories: (await memories.search(request.query)).memories,
    }),
    addKnowledge: async (request) => ({
      id: (await memories.add(request.content)).id,
    }),
    deleteKnowledge: (request) => memories.remove(request.id),
    clearKnowledge: (request) => memories.clear(request.expectedCount),
    listEnvironments: () => ({
      environments: operations.environments.flatMap((item) => item.environment ?? []),
    }),
    listHarnesses: (request) => harnesses.list(request.namespace),
    saveHarness: (request) => harnesses.save(request),
    deleteHarness: (request) => harnesses.remove(request),
    getEngineerRuntime: (request) => runtime.read(request.ref),
    setEngineerRuntime: (request) => runtime.assign(request),
  };
}
