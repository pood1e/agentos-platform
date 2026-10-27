import {
  Code,
  ConnectError,
  type ConnectRouter,
  createClient,
  type HandlerContext,
} from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import type { FastifyBaseLogger } from "fastify";
import { Capability } from "../../gen/agentos/authorization/v1/permission_pb.js";
import { MemoryService } from "../../gen/kagent/runtime/v1/memory_pb.js";
import { TaskStoreService } from "../../gen/kagent/runtime/v1/task_store_pb.js";
import { can } from "../../shared/permissions.js";
import type { KagentClients } from "../kagent/clients.js";
import type { KnowledgeConfig } from "../knowledge/service.js";
import { agentKey } from "../read-model/agents.js";
import { object, text } from "../read-model/decode/messages.js";
import type { Native } from "../read-model/projection.js";
import type { KagentConfig } from "../shared/config.js";
import type { ExecutionRuntime } from "./runtime.js";

const denied = () =>
  new ConnectError("Runtime operation is outside this execution", Code.PermissionDenied);

/** Runtime traffic exposes only official persistence RPCs, with identity supplied by the host. */
export function registerRuntime(
  router: ConnectRouter,
  runtime: ExecutionRuntime,
  config: KagentConfig,
  clients: KagentClients,
  sharedKnowledge?: KnowledgeConfig["scope"],
  project: (tasks: Native[]) => Promise<void> = async () => {},
  log?: Pick<FastifyBaseLogger, "warn">,
) {
  const transport = createGrpcTransport({ baseUrl: config.url });
  const tasks = createClient(TaskStoreService, transport),
    memory = createClient(MemoryService, transport);

  async function taskOptions(
    sessionId: string,
    context: HandlerContext,
    mode: "read" | "create" | "update" = "read",
    messageIds: string[] = [],
  ) {
    const { session } = await runtime.authenticatedActor(context.requestHeader);
    if (session.id !== sessionId) throw denied();
    // Signed Actors can read their own store before the initial task establishes admission.
    if (mode !== "read") await runtime.registry.record(session, mode === "update", messageIds);
    return {
      tenant: agentKey(session.agent),
      options: {
        signal: context.signal,
        timeoutMs: 15_000,
        headers: {
          authorization: context.requestHeader.get("authorization") ?? "",
        },
      },
    };
  }
  /** The projection follows successful native writes; its failures never fail the runtime. */
  const projected = <T>(tenant: string, task: Native["task"] | undefined, response: T) => {
    if (task)
      void project([{ task, agentId: tenant }]).catch((error: unknown) =>
        log?.warn({ err: error, taskId: task.id }, "Task projection write failed"),
      );
    return response;
  };

  async function memoryOptions(context: HandlerContext, write: boolean, requested = "") {
    const { session } = await runtime.authenticatedActor(context.requestHeader);
    const execution = await runtime.registry.resolve(session);
    const agentName = agentKey(session.agent);
    if (requested && requested !== agentName) throw denied();
    if (write) {
      if (agentName === sharedKnowledge?.agentName && !can(execution, Capability.KNOWLEDGE_MANAGE))
        throw denied();
      const { agent } = await clients.agents.getAgent({ ref: session.agent }, { timeoutMs: 5_000 });
      if (!agent) throw denied();
      const spec = object(agent.resource?.value?.spec),
        ref = object(spec.harnessRef);
      const { harnesses } = await clients.harnesses.listHarnesses(
        { namespace: session.agent?.namespace },
        { timeoutMs: 5_000 },
      );
      const harness = harnesses.find((item) => item.ref?.name === text(ref.name));
      const harnessSpec = object(harness?.resource?.value?.spec);
      if (!object(harnessSpec.kagent).memory) throw denied();
    }
    const userId =
      agentName === sharedKnowledge?.agentName
        ? sharedKnowledge.userId
        : execution.identity.subject;
    return {
      agentName,
      options: {
        signal: context.signal,
        timeoutMs: 15_000,
        headers: {
          "X-User-Id": userId,
          ...(config.token ? { authorization: `Bearer ${config.token}` } : {}),
        },
      },
    };
  }

  router.service(TaskStoreService, {
    createTask: async (r, c) => {
      if (r.task?.contextId !== r.sessionId) throw denied();
      const { tenant, options } = await taskOptions(
        r.sessionId,
        c,
        "create",
        r.task.history.map((message) => message.messageId),
      );
      return projected(tenant, r.task, await tasks.createTask(r, options));
    },
    getTask: async (r, c) => tasks.getTask(r, (await taskOptions(r.sessionId, c)).options),
    updateTask: async (r, c) => {
      if (r.task?.contextId !== r.sessionId) throw denied();
      const { tenant, options } = await taskOptions(r.sessionId, c, "update");
      return projected(tenant, r.task, await tasks.updateTask(r, options));
    },
    listTasks: async (r, c) => {
      if (!r.request || (r.request.contextId && r.request.contextId !== r.sessionId))
        throw denied();
      r.request.contextId = r.sessionId;
      return tasks.listTasks(r, (await taskOptions(r.sessionId, c)).options);
    },
    settleTask: async (r, c) =>
      tasks.settleTask(r, (await taskOptions(r.sessionId, c, "update")).options),
  });
  router.service(MemoryService, {
    addSession: async (r, c) => {
      if (!r.memory) throw denied();
      const { agentName, options } = await memoryOptions(c, true, r.managementAgent);
      return memory.addSession({ ...r, managementAgent: agentName }, options);
    },
    addSessionBatch: async (r, c) => {
      const { agentName, options } = await memoryOptions(c, true, r.managementAgent);
      return memory.addSessionBatch({ ...r, managementAgent: agentName }, options);
    },
    search: async (r, c) => {
      const { agentName, options } = await memoryOptions(c, false, r.managementAgent);
      return memory.search({ ...r, managementAgent: agentName }, options);
    },
    list: async (r, c) => {
      const { agentName, options } = await memoryOptions(c, false, r.agentName);
      return memory.list({ ...r, agentName }, options);
    },
    delete: async (r, c) => {
      const { agentName, options } = await memoryOptions(c, true, r.agentName);
      return memory.delete({ ...r, agentName }, options);
    },
    deleteEntry: async (r, c) => {
      const { agentName, options } = await memoryOptions(c, true, r.agentName);
      return memory.deleteEntry({ ...r, agentName }, options);
    },
  });
}
