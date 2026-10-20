import {
  Code,
  ConnectError,
  type ConnectRouter,
  createClient,
  type HandlerContext,
} from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { MemoryService } from "../../gen/kagent/api/v1alpha1/memory_pb.js";
import { TaskStoreService } from "../../gen/kagent/api/v1alpha1/task_store_pb.js";
import type { KagentClients } from "../kagent/clients.js";
import { agentKey } from "../read-model/agents.js";
import { object, text } from "../read-model/decode/messages.js";
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
) {
  const transport = createGrpcTransport({ baseUrl: config.url });
  const tasks = createClient(TaskStoreService, transport),
    memory = createClient(MemoryService, transport);

  async function taskOptions(sessionId: string, context: HandlerContext, create = false) {
    const { session, actor } = await runtime.authenticatedActor(context.requestHeader);
    if (session.id !== sessionId) throw denied();
    if (create) await runtime.registry.record(session);
    else await runtime.registry.record(session, true);
    return {
      signal: context.signal,
      timeoutMs: 15_000,
      headers: {
        "x-kagent-insecure-runtime-identity": `${actor.atespace}/${actor.name}/${actor.uid}`,
      },
    };
  }

  async function memoryOptions(agentName: string, context: HandlerContext, write: boolean) {
    const { session } = await runtime.authenticatedActor(context.requestHeader);
    const execution = await runtime.registry.resolve(session);
    if (!agentName.startsWith(`${session.agent?.namespace}/`)) throw denied();
    if (write) {
      if (!execution.write || agentName !== agentKey(session.agent)) throw denied();
      const { agent } = await clients.agents.getAgent({ ref: session.agent }, { timeoutMs: 5_000 });
      if (!agent) throw denied();
      const spec = object(agent.resource?.value?.spec),
        ref = object(spec.harnessRef);
      const { harnesses } = await clients.harnesses.listHarnesses(
        { namespace: session.agent?.namespace },
        { timeoutMs: 5_000 },
      );
      const harness = harnesses.find((item) => item.ref?.name === text(ref.name));
      const harnessSpec = object(harness?.resource?.value?.spec ?? spec.harness);
      if (!object(harnessSpec.kagent).memory) throw denied();
    }
    return {
      userId: session.creator,
      options: {
        signal: context.signal,
        timeoutMs: 15_000,
        headers: {
          "X-User-Id": session.creator,
          ...(config.token ? { authorization: `Bearer ${config.token}` } : {}),
        },
      },
    };
  }

  router.service(TaskStoreService, {
    createTask: async (r, c) => {
      if (r.task?.contextId !== r.sessionId) throw denied();
      return tasks.createTask(r, await taskOptions(r.sessionId, c, true));
    },
    getTask: async (r, c) => tasks.getTask(r, await taskOptions(r.sessionId, c)),
    updateTask: async (r, c) => {
      if (r.task?.contextId !== r.sessionId) throw denied();
      return tasks.updateTask(r, await taskOptions(r.sessionId, c));
    },
    listTasks: async (r, c) => {
      if (!r.request || (r.request.contextId && r.request.contextId !== r.sessionId))
        throw denied();
      r.request.contextId = r.sessionId;
      return tasks.listTasks(r, await taskOptions(r.sessionId, c));
    },
    settleTask: async (r, c) => tasks.settleTask(r, await taskOptions(r.sessionId, c)),
  });
  router.service(MemoryService, {
    addSession: async (r, c) => {
      if (!r.memory) throw denied();
      const { userId, options } = await memoryOptions(r.memory.agentName, c, true);
      r.memory.userId = userId;
      return memory.addSession(r, options);
    },
    addSessionBatch: async (r, c) => {
      const first = r.items[0];
      if (!first || r.items.some((item) => item.agentName !== first.agentName)) throw denied();
      const { userId, options } = await memoryOptions(first.agentName, c, true);
      for (const item of r.items) item.userId = userId;
      return memory.addSessionBatch(r, options);
    },
    search: async (r, c) => {
      const { userId, options } = await memoryOptions(r.agentName, c, false);
      return memory.search({ ...r, userId }, options);
    },
    list: async (r, c) => {
      const { userId, options } = await memoryOptions(r.agentName, c, false);
      return memory.list({ ...r, userId }, options);
    },
    delete: async (r, c) => {
      const { userId, options } = await memoryOptions(r.agentName, c, true);
      return memory.delete({ ...r, userId }, options);
    },
    deleteEntry: async (r, c) => {
      const { userId, options } = await memoryOptions(r.agentName, c, true);
      return memory.deleteEntry({ ...r, userId }, options);
    },
  });
}
