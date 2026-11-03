import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type ConnectRouter } from "@connectrpc/connect";
import {
  AgentTemplateSchema,
  AgentTemplateService,
} from "../../gen/kagent/api/v1/agent_templates_pb.js";
import { AgentSchema, AgentService } from "../../gen/kagent/api/v1/agents_pb.js";
import { HarnessSchema, HarnessService } from "../../gen/kagent/api/v1/harnesses_pb.js";
import { ModelConfigSchema, ModelService } from "../../gen/kagent/api/v1/models_pb.js";
import { ToolService } from "../../gen/kagent/api/v1/tools_pb.js";
import { agentKey } from "../../server/kagent/resources.js";
import { object } from "../../shared/json.js";
import { appHTML, appService, appTools, appUri } from "./apps.js";
import type { FakeKagent } from "./kagent.js";

export const page = <T>(items: T[], token: string, size: number) => {
  const offset = Number(token || "0");
  const next = offset + size;
  return { items: items.slice(offset, next), token: next < items.length ? String(next) : "" };
};

function asHarness(value: import("@bufbuild/protobuf").JsonObject) {
  return create(HarnessSchema, {
    ref: { namespace: "agentos", name: String(object(value.metadata).name) },
    resource: { apiVersion: String(value.apiVersion), kind: "Harness", value },
    runtime: ["kagent", "codex", "claude", "byo"].find(
      (key) => object(value.spec)[key] !== undefined,
    ),
    workloadImage: String(object(object(value.spec).workload).image ?? ""),
  });
}

/** Native resource services backed by the fake Kubernetes store. */
export function resourceRoutes(fake: FakeKagent, router: ConnectRouter) {
  router.service(HarnessService, {
    listHarnesses: () => ({ harnesses: fake.resources.list("harnesses").map(asHarness) }),
    getHarness: (request) => ({
      harness: asHarness(fake.resources.get("harnesses", request.ref?.name ?? "")),
    }),
    createHarness: (request) => ({
      harness: asHarness(fake.resources.save("harnesses", request.resource?.value ?? {}, true)),
    }),
    updateHarness: (request) => ({
      harness: asHarness(fake.resources.save("harnesses", request.resource?.value ?? {}, false)),
    }),
    deleteHarness(request) {
      fake.resources.remove("harnesses", request.ref?.name ?? "", request.resourceVersion);
      return {};
    },
  });
  router.service(AgentService, {
    listAgents(request) {
      const { items, token } = page(
        fake.agents.filter((agent) => agent.ref?.namespace === request.namespace),
        request.page?.pageToken ?? "",
        request.page?.limit || 100,
      );
      return { agents: items, page: { nextPageToken: token } };
    },
    getAgent(request) {
      const agent = fake.agents.find((item) => agentKey(item.ref) === agentKey(request.ref));
      if (!agent) throw new ConnectError("agent not found", Code.NotFound);
      return { agent };
    },
    validateAgent: () => ({}),
    updateAgent(request) {
      const saved = fake.resources.save("agents", request.resource?.value ?? {}, false);
      return {
        agent: create(AgentSchema, {
          ref: request.ref,
          resource: { apiVersion: "api.kagent.dev/v1alpha3", kind: "Agent", value: saved },
        }),
      };
    },
    createAgent(request) {
      const value = request.resource?.value ?? {};
      const saved = fake.resources.save(
        "agents",
        {
          ...value,
          metadata: {
            ...object(value.metadata),
            name: request.ref?.name ?? "",
            namespace: request.ref?.namespace ?? "agentos",
          },
          status: { conditions: [{ type: "Ready", status: "True" }] },
        },
        true,
      );
      const agent = create(AgentSchema, {
        ref: request.ref,
        resource: {
          apiVersion: request.resource?.apiVersion,
          kind: request.resource?.kind,
          value: saved,
        },
      });
      return { agent };
    },
  });
  router.service(AgentTemplateService, {
    listAgentTemplates(request) {
      const { items, token } = page(
        [...fake.templates.values()].filter(
          (template) => template.ref?.namespace === request.namespace,
        ),
        request.page?.pageToken ?? "",
        request.page?.limit || 100,
      );
      return { agentTemplates: items, page: { nextPageToken: token } };
    },
    getAgentTemplate: (request) => ({ agentTemplate: fake.template(request.ref?.name ?? "") }),
    createAgentTemplate(request) {
      const name = request.ref?.name ?? "";
      if (fake.templates.has(name))
        throw new ConnectError("AgentTemplate already exists", Code.AlreadyExists);
      const value = request.resource?.value ?? {};
      const agentTemplate = create(AgentTemplateSchema, {
        ref: request.ref,
        resource: {
          apiVersion: request.resource?.apiVersion,
          kind: request.resource?.kind,
          value: { ...value, metadata: { ...object(value.metadata), resourceVersion: "1" } },
        },
      });
      fake.templates.set(name, agentTemplate);
      return { agentTemplate };
    },
    updateAgentTemplate: (request) => ({
      agentTemplate: fake.replaceTemplate(
        create(AgentTemplateSchema, { ref: request.ref, resource: request.resource }),
      ),
    }),
    deleteAgentTemplate(request) {
      fake.templates.delete(request.ref?.name ?? "");
      return {};
    },
  });
  router.service(ModelService, {
    getModelConfig({ ref }) {
      const value = fake.resources.get("modelconfigs", ref?.name ?? "");
      return {
        modelConfig: create(ModelConfigSchema, {
          ref,
          resource: { apiVersion: "api.kagent.dev/v1alpha3", kind: "ModelConfig", value },
        }),
      };
    },
    listModelConfigs: () => ({
      modelConfigs: fake.resources.list("modelconfigs").map((value) =>
        create(ModelConfigSchema, {
          ref: { namespace: "agentos", name: String(object(value.metadata).name) },
          resource: { apiVersion: "api.kagent.dev/v1alpha3", kind: "ModelConfig", value },
        }),
      ),
    }),
  });
  router.service(ToolService, {
    listToolServers: () => ({ toolServers: fake.toolServers }),
    listMCPAppTools: (request) => ({
      tools: request.server?.ref?.name === appService ? appTools() : [],
    }),
    readMCPAppResource: async (request) => {
      if (request.server?.ref?.name !== appService || request.uri !== appUri)
        throw new ConnectError("App resource missing", Code.NotFound);
      return {
        result: {
          value: {
            contents: [
              {
                uri: appUri,
                mimeType: "text/html;profile=mcp-app",
                text: await appHTML(),
                _meta: {
                  ui: {
                    csp: {
                      resourceDomains: ["data:", "https://untrusted.example"],
                      connectDomains: ["https://untrusted.example"],
                    },
                    permissions: { camera: {} },
                  },
                },
              },
            ],
          },
        },
      };
    },
  });
}
