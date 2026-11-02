import { EventEmitter } from "node:events";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import type { Message } from "../../gen/a2a_pb.js";
import {
  TaskCatalogScopeSchema,
  TaskCatalogView,
} from "../../gen/kagent/api/v1/task_catalog_pb.js";
import { listNativeAgents, listNativeTemplates } from "../kagent/catalog.js";
import { eachPage, type KagentClients } from "../kagent/clients.js";
import { acceptMessage } from "../kagent/send.js";
import { agentInfo, agentKey, sessionInfo } from "./agents.js";
import { type CatalogRows, catalogGraph } from "./catalog-entries.js";
import { hitlExtension } from "./decode/hitl.js";
import { ingest } from "./entry.js";
import { listings } from "./listings.js";

const rpc = { timeoutMs: 10_000 };
const graphPageSize = 12;
const missing = (error: unknown) => error instanceof ConnectError && error.code === Code.NotFound;

/** Native catalog reads and exact A2A task access share the caller's authority. */
export function taskQueries({ workspace, clients }: { workspace: string; clients: KagentClients }) {
  const changes = new EventEmitter().setMaxListeners(0);
  async function agents(signal?: AbortSignal) {
    const [agents, templates] = await Promise.all([
      listNativeAgents(clients, workspace, { ...rpc, signal }),
      listNativeTemplates(clients, workspace, { ...rpc, signal }),
    ]);
    const byName = new Map(templates.map((value) => [agentKey(value.ref), value]));
    return agents.map((value) => agentInfo(value, byName));
  }
  async function session(id: string, signal?: AbortSignal) {
    try {
      const { session } = await clients.sessions.getSession({ sessionId: id }, { ...rpc, signal });
      return session?.agent?.namespace === workspace ? sessionInfo(session) : undefined;
    } catch (error) {
      if (missing(error)) return undefined;
      throw error;
    }
  }
  async function withExecution(
    task: Parameters<typeof ingest>[0],
    agentId: string,
    signal?: AbortSignal,
  ) {
    const { execution } = await clients.execution.getTaskExecution(
      { taskId: task.id },
      { ...rpc, signal },
    );
    if (execution?.task?.taskId !== task.id || execution.task.sessionId !== task.contextId)
      throw new ConnectError("Native task relationship unavailable", Code.FailedPrecondition);
    return ingest(task, agentId, execution);
  }
  async function entry(id: string, signal?: AbortSignal) {
    try {
      const task = await clients.a2a.getTask({ id }, { ...rpc, signal });
      const known = await session(task.contextId, signal);
      return known
        ? {
            ...(await withExecution(task, known.agentId, signal)),
            root: known.root,
            subject: known.subject,
          }
        : undefined;
    } catch (error) {
      if (missing(error)) return undefined;
      throw error;
    }
  }
  async function graph(anchor: string, signal?: AbortSignal) {
    const read = async () => {
      const rows: CatalogRows = { tasks: [], sessions: [] };
      const sessions = new Map<string, CatalogRows["sessions"][number]>();
      await eachPage(
        async (pageToken) => {
          let limit = graphPageSize;
          for (;;) {
            try {
              const result = await clients.catalog.listTaskRecords(
                {
                  scope: create(TaskCatalogScopeSchema, {
                    namespace: workspace,
                    visibility: { case: "sessionTreeAnchor", value: anchor },
                  }),
                  page: { limit, pageToken },
                  view: TaskCatalogView.DETAILS,
                },
                { ...rpc, signal },
              );
              for (const session of result.sessions) sessions.set(session.id, session);
              return { items: result.tasks, token: result.page?.nextPageToken ?? "" };
            } catch (error) {
              if (
                !(error instanceof ConnectError) ||
                error.code !== Code.ResourceExhausted ||
                limit === 1
              )
                throw error;
              limit = Math.max(1, Math.floor(limit / 2));
            }
          }
        },
        (items) => rows.tasks.push(...items),
      );
      rows.sessions = [...sessions.values()];
      return rows;
    };
    const [rows, members] = await Promise.all([read(), agents(signal)]);
    return catalogGraph(workspace, rows, members);
  }
  return {
    ...listings({ workspace, clients, agents }),
    agents,
    session,
    entry,
    graph,
    async agent(id: string) {
      return (await agents()).find((value) => value.id === id);
    },
    async graphOf(id: { taskId?: string; contextId?: string }, signal?: AbortSignal) {
      const value = id.taskId
        ? await entry(id.taskId, signal)
        : await session(id.contextId ?? "", signal);
      return value ? graph("contextId" in value ? value.contextId : value.id, signal) : undefined;
    },
    async fullTask(value: { id: string; agentId: string }) {
      try {
        return await clients.a2a.getTask({ tenant: value.agentId, id: value.id }, rpc);
      } catch (error) {
        if (missing(error)) return undefined;
        throw error;
      }
    },
    async send(tenant: string, message: Message) {
      const task = await acceptMessage(clients.a2a, tenant, message, {
        "A2A-Extensions": hitlExtension,
      });
      changes.emit("change");
      return task;
    },
    onChange(listener: () => void) {
      changes.on("change", listener);
      return () => {
        changes.off("change", listener);
      };
    },
  };
}
export type TaskQueries = ReturnType<typeof taskQueries>;
