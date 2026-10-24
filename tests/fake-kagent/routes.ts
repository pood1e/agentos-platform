import { create } from "@bufbuild/protobuf";
import { timestampMs } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError, type ConnectRouter } from "@connectrpc/connect";
import { A2AService, TaskState } from "../../gen/a2a_pb.js";
import {
  AgentTemplateSchema,
  AgentTemplateService,
} from "../../gen/kagent/api/v1/agent_templates_pb.js";
import { AgentSchema, AgentService } from "../../gen/kagent/api/v1/agents_pb.js";
import { HarnessService } from "../../gen/kagent/api/v1/harnesses_pb.js";
import { ModelConfigSchema, ModelService } from "../../gen/kagent/api/v1/models_pb.js";
import { ScheduledRunService } from "../../gen/kagent/api/v1/scheduled_runs_pb.js";
import { SessionService } from "../../gen/kagent/api/v1/sessions_pb.js";
import { ToolService } from "../../gen/kagent/api/v1/tools_pb.js";
import { MemoryService } from "../../gen/kagent/runtime/v1/memory_pb.js";
import { agentKey } from "../../server/read-model/agents.js";
import { millis, object } from "../../server/read-model/decode/messages.js";
import { terminal } from "../../server/read-model/state.js";
import { appHTML, appService, appTools, appUri } from "./apps.js";
import type { FakeKagent } from "./kagent.js";

const page = <T>(items: T[], token: string, size: number) => {
  const offset = Number(token || "0");
  const next = offset + size;
  return { items: items.slice(offset, next), token: next < items.length ? String(next) : "" };
};

/** Official kagent and A2A services backed by the fake runtime. */
export const kagentRoutes = (fake: FakeKagent) => (router: ConnectRouter) => {
  router.service(HarnessService, {
    listHarnesses: () => ({
      harnesses: fake.resources.list("harnesses").map((resource) => ({
        ref: { namespace: "agentos", name: String(object(resource.metadata).name) },
        resource: { apiVersion: String(resource.apiVersion), kind: "Harness", value: resource },
        runtime: ["kagent", "codex", "claude", "byo"].find(
          (key) => object(resource.spec)[key] !== undefined,
        ),
        workloadImage: String(object(object(resource.spec).workload).image ?? ""),
      })),
    }),
  });
  router.service(AgentService, {
    listAgents: (request) => ({
      agents: fake.agents.filter((agent) => agent.ref?.namespace === request.namespace),
    }),
    getAgent(request) {
      const agent = fake.agents.find((item) => agentKey(item.ref) === agentKey(request.ref));
      if (!agent) throw new ConnectError("agent not found", Code.NotFound);
      return { agent };
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
  router.service(SessionService, {
    listSessions(request) {
      const { items, token } = page(
        [...fake.sessions.values()],
        request.page?.pageToken ?? "",
        request.page?.limit || 100,
      );
      return { sessions: items, page: { nextPageToken: token } };
    },
    getSession(request) {
      const session = fake.sessions.get(request.sessionId);
      if (!session) throw new ConnectError("session not found", Code.NotFound);
      return { session };
    },
    deleteSession(request) {
      const session = fake.sessions.get(request.sessionId);
      if (!session) throw new ConnectError("session not found", Code.NotFound);
      fake.sessions.delete(session.id);
      for (const task of fake.tasks.values())
        if (task.contextId === session.id) fake.tasks.delete(task.id);
      return { session };
    },
    createSession: (request) => ({
      session: fake.createSession(
        { namespace: request.agent?.namespace ?? "", name: request.agent?.name ?? "" },
        request.requestId,
        request.name,
      ),
    }),
  });
  router.service(A2AService, {
    listTasks(request) {
      const after = request.statusTimestampAfter
        ? timestampMs(request.statusTimestampAfter)
        : undefined;
      const tasks = [...fake.tasks.values()].filter(
        (task) =>
          fake.tenantOf(task) === request.tenant &&
          (!request.contextId || task.contextId === request.contextId) &&
          (after === undefined || (millis(task.status?.timestamp) ?? 0) > after),
      );
      const { items, token } = page(tasks, request.pageToken, request.pageSize ?? 50);
      fake.listed.push({
        tenant: request.tenant,
        incremental: after !== undefined,
        returned: items.length,
      });
      return {
        tasks: items,
        nextPageToken: token,
        pageSize: items.length,
        totalSize: tasks.length,
      };
    },
    getTask(request) {
      fake.fetched.push(request.id);
      return fake.task(request.id);
    },
    cancelTask(request) {
      const task = fake.task(request.id);
      if (fake.tenantOf(task) !== request.tenant)
        throw new ConnectError("task not found", Code.NotFound);
      if (!terminal(task.status?.state)) fake.update(task, TaskState.CANCELED);
      return task;
    },
    subscribeToTask: (request, context) => fake.follow(request.id, context.signal),
    async *sendStreamingMessage(request, context) {
      if (!request.message) throw new ConnectError("message required", Code.InvalidArgument);
      yield* fake.follow(fake.accept(request.message).id, context.signal);
    },
    sendMessage(request) {
      if (!request.message) throw new ConnectError("message required", Code.InvalidArgument);
      return { payload: { case: "task", value: fake.accept(request.message) } };
    },
  });
  router.service(AgentTemplateService, {
    listAgentTemplates: () => ({ agentTemplates: [...fake.templates.values()] }),
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
    updateAgentTemplate(request) {
      // kagent copies only the spec; metadata and annotations stay as stored.
      const existing = fake.template(request.ref?.name ?? "");
      const stored = existing.resource?.value ?? {};
      const metadata = object(stored.metadata);
      const agentTemplate = create(AgentTemplateSchema, {
        ref: existing.ref,
        resource: {
          apiVersion: existing.resource?.apiVersion,
          kind: existing.resource?.kind,
          value: {
            ...stored,
            metadata: {
              ...metadata,
              resourceVersion: String(Number(metadata.resourceVersion) + 1),
            },
            spec: request.resource?.value?.spec ?? null,
          },
        },
      });
      fake.templates.set(request.ref?.name ?? "", agentTemplate);
      return { agentTemplate };
    },
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
  router.service(MemoryService, fake.memory.service());
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
  router.service(ScheduledRunService, fake.schedules.service());
  return router;
};
