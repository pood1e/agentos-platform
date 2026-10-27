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
import type { KagentConfig } from "../shared/config.js";
import type { ExecutionRuntime } from "./runtime.js";

const denied = () =>
  new ConnectError("Runtime operation is outside this execution", Code.PermissionDenied);

/** Node and postgres.js codes for a connection or stream lost before a response. */
const lostTransport = new Set([
  "CONNECTION_CLOSED",
  "CONNECTION_DESTROYED",
  "CONNECTION_ENDED",
  "CONNECT_TIMEOUT",
  "ECONNREFUSED",
  "ECONNRESET",
  "EPIPE",
  "ERR_HTTP2_GOAWAY_SESSION",
  "ERR_HTTP2_INVALID_SESSION",
  "ERR_HTTP2_INVALID_STREAM",
  "ERR_HTTP2_STREAM_CANCEL",
  "ERR_HTTP2_STREAM_ERROR",
  "ERR_STREAM_DESTROYED",
  "ERR_STREAM_PREMATURE_CLOSE",
  "ETIMEDOUT",
]);

function transportLost(error: unknown) {
  for (let cause = error, depth = 0; cause instanceof Error && depth < 8; depth++) {
    if ("code" in cause && typeof cause.code === "string" && lostTransport.has(cause.code))
      return true;
    cause = cause.cause;
  }
  return false;
}

/** Runtime traffic exposes only official persistence RPCs, with identity supplied by the host. */
export function registerRuntime(
  router: ConnectRouter,
  runtime: ExecutionRuntime,
  config: KagentConfig,
  clients: KagentClients,
  sharedKnowledge?: KnowledgeConfig["scope"],
  log?: Pick<FastifyBaseLogger, "warn">,
) {
  const transport = createGrpcTransport({ baseUrl: config.url });
  const tasks = createClient(TaskStoreService, transport),
    memory = createClient(MemoryService, transport);

  /** Lost transport is Unavailable, which the runtime replays with the same immutable mutation. */
  async function forward<T>(
    context: HandlerContext,
    method: string,
    call: () => Promise<T>,
  ): Promise<T> {
    try {
      return await call();
    } catch (error) {
      // An upstream cancellation the runtime did not request means the stream was reset in transit.
      const reset =
        error instanceof ConnectError && error.code === Code.Canceled && !context.signal.aborted;
      if (!reset && !transportLost(error)) throw error;
      log?.warn({ err: error, method }, "Runtime persistence transport lost");
      throw new ConnectError(
        "Runtime persistence transport lost",
        Code.Unavailable,
        undefined,
        undefined,
        error,
      );
    }
  }

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
      signal: context.signal,
      timeoutMs: 15_000,
      headers: {
        authorization: context.requestHeader.get("authorization") ?? "",
      },
    };
  }

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
    createTask: (r, c) =>
      forward(c, "CreateTask", async () => {
        if (r.task?.contextId !== r.sessionId) throw denied();
        return tasks.createTask(
          r,
          await taskOptions(
            r.sessionId,
            c,
            "create",
            r.task.history.map((message) => message.messageId),
          ),
        );
      }),
    getTask: (r, c) =>
      forward(c, "GetTask", async () => tasks.getTask(r, await taskOptions(r.sessionId, c))),
    updateTask: (r, c) =>
      forward(c, "UpdateTask", async () => {
        if (r.task?.contextId !== r.sessionId) throw denied();
        return tasks.updateTask(r, await taskOptions(r.sessionId, c, "update"));
      }),
    listTasks: (r, c) =>
      forward(c, "ListTasks", async () => {
        if (!r.request || (r.request.contextId && r.request.contextId !== r.sessionId))
          throw denied();
        r.request.contextId = r.sessionId;
        return tasks.listTasks(r, await taskOptions(r.sessionId, c));
      }),
    settleTask: (r, c) =>
      forward(c, "SettleTask", async () =>
        tasks.settleTask(r, await taskOptions(r.sessionId, c, "update")),
      ),
  });
  router.service(MemoryService, {
    addSession: (r, c) =>
      forward(c, "AddSession", async () => {
        if (!r.memory) throw denied();
        const { agentName, options } = await memoryOptions(c, true, r.managementAgent);
        return memory.addSession({ ...r, managementAgent: agentName }, options);
      }),
    addSessionBatch: (r, c) =>
      forward(c, "AddSessionBatch", async () => {
        const { agentName, options } = await memoryOptions(c, true, r.managementAgent);
        return memory.addSessionBatch({ ...r, managementAgent: agentName }, options);
      }),
    search: (r, c) =>
      forward(c, "Search", async () => {
        const { agentName, options } = await memoryOptions(c, false, r.managementAgent);
        return memory.search({ ...r, managementAgent: agentName }, options);
      }),
    list: (r, c) =>
      forward(c, "List", async () => {
        const { agentName, options } = await memoryOptions(c, false, r.agentName);
        return memory.list({ ...r, agentName }, options);
      }),
    delete: (r, c) =>
      forward(c, "Delete", async () => {
        const { agentName, options } = await memoryOptions(c, true, r.agentName);
        return memory.delete({ ...r, agentName }, options);
      }),
    deleteEntry: (r, c) =>
      forward(c, "DeleteEntry", async () => {
        const { agentName, options } = await memoryOptions(c, true, r.agentName);
        return memory.deleteEntry({ ...r, agentName }, options);
      }),
  });
}
