import { EventEmitter } from "node:events";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import type { Message } from "../../gen/a2a_pb.js";
import {
  TaskCatalogScopeSchema,
  TaskCatalogView,
} from "../../gen/kagent/api/v1/task_catalog_pb.js";
import { listNativeAgents, listNativeTemplates } from "../kagent/catalog.js";
import type { KagentClients } from "../kagent/clients.js";
import { agentKey } from "../kagent/resources.js";
import { acceptMessage } from "../kagent/send.js";
import { eachPage } from "../shared/async.js";
import { hasCode, unlessMissing } from "../shared/errors.js";
import { agentInfo, sessionInfo } from "./agents.js";
import { type CatalogRows, catalogGraph } from "./catalog-entries.js";
import { hitlExtension } from "./decode/hitl.js";
import { ingest } from "./entry.js";
import { listings } from "./listings.js";

const rpc = { timeoutMs: 10_000 };
const graphPageSize = 12;

/** Native catalog reads and exact A2A task access share the caller's authority. */
export function taskQueries({
  workspace,
  workspaceUID,
  clients,
}: {
  workspace: string;
  workspaceUID: () => Promise<string>;
  clients: KagentClients;
}) {
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
    const session = (
      await unlessMissing(clients.sessions.getSession({ sessionId: id }, { ...rpc, signal }))
    )?.session;
    if (session?.agent?.namespace !== workspace) return undefined;
    const uid = await workspaceUID();
    return uid !== "" && session.authority?.workspaceUid === uid ? sessionInfo(session) : undefined;
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
    const task = await unlessMissing(clients.a2a.getTask({ id }, { ...rpc, signal }));
    const known = task && (await session(task.contextId, signal));
    if (!task || !known) return undefined;
    const projected = await unlessMissing(withExecution(task, known.agentId, signal));
    return projected && { ...projected, root: known.root, subject: known.subject };
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
              if (!hasCode(error, Code.ResourceExhausted) || limit === 1) throw error;
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
    fullTask: (value: { id: string; agentId: string }) =>
      unlessMissing(clients.a2a.getTask({ tenant: value.agentId, id: value.id }, rpc)),
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
