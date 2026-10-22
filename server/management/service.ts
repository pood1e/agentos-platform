import { fromJsonString } from "@bufbuild/protobuf";
import type { ServiceImpl } from "@connectrpc/connect";
import {
  GetSchemasResponseSchema,
  type ManagementService,
} from "../../gen/agentos/management/v1/management_pb.js";
import mcpSchema from "../../gen/schema/agentgateway.mcp.json" with { type: "json" };
import modelSchema from "../../gen/schema/agentgateway.model.json" with { type: "json" };
import synthesisSchema from "../../gen/schema/agentos.console.v1.SpeechSynthesis.jsonschema.bundle.json" with {
  type: "json",
};
import transcriptionSchema from "../../gen/schema/agentos.console.v1.SpeechTranscription.jsonschema.bundle.json" with {
  type: "json",
};
import harnessSchema from "../../gen/schema/kagent.harness.json" with { type: "json" };
import type { KagentClients } from "../kagent/clients.js";
import { type KnowledgeConfig, knowledgeService } from "../knowledge/service.js";
import type { SpeechSettingsStore } from "../speech/store.js";
import { connectionCommands, type GatewayConfig } from "./connections.js";
import { engineerRuntime } from "./engineer-runtime.js";
import { harnessCommands } from "./harnesses.js";
import type { ResourceStore } from "./resources.js";
import { skillCommands } from "./skills.js";

const schemas = fromJsonString(
  GetSchemasResponseSchema,
  JSON.stringify({
    model: modelSchema,
    mcp: mcpSchema,
    harness: harnessSchema,
    speechTranscription: transcriptionSchema,
    speechSynthesis: synthesisSchema,
  }),
);

export interface ManagementDependencies {
  store: ResourceStore;
  clients: KagentClients;
  gateway: GatewayConfig;
  knowledge: KnowledgeConfig;
  speech: SpeechSettingsStore;
}

export function managementService({
  store,
  clients,
  gateway,
  knowledge,
  speech,
}: ManagementDependencies): ServiceImpl<typeof ManagementService> {
  const connections = connectionCommands(store, clients, gateway);
  const skills = skillCommands(store, clients, gateway.namespace);
  const memories = knowledgeService(clients, knowledge);
  const harnesses = harnessCommands(store, gateway.namespace);
  const runtime = engineerRuntime(store, clients, gateway.namespace);
  return {
    getSchemas: () => schemas,
    listConnections: (request) => connections.list(request),
    saveConnection: (request) => connections.save(request),
    deleteConnection: (request) =>
      connections.remove(request.kind, request.name, request.resourceVersion),
    getSpeechConfiguration: () => speech.get(),
    saveSpeechConfiguration: (request) => speech.save(request),
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
    listHarnesses: (request) => harnesses.list(request.namespace),
    saveHarness: (request) => harnesses.save(request),
    deleteHarness: (request) => harnesses.remove(request),
    getEngineerRuntime: (request) => runtime.read(request.ref),
    setEngineerRuntime: (request) => runtime.assign(request),
  };
}
