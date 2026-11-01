import { serialize } from "node:v8";
import { toJson } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { LRUCache } from "lru-cache";
import { TaskSchema } from "../../gen/a2a_pb.js";
import type { TaskExecution } from "../../gen/kagent/api/v1/execution_pb.js";
import { digest } from "../../shared/digest.js";
import { eachPage, type KagentClients, pool } from "../kagent/clients.js";
import type { SessionInfo } from "./agents.js";
import { ingest, type TaskEntry } from "./entry.js";
import { terminal } from "./state.js";

export interface TaskRecord {
  summary: TaskEntry;
  session: SessionInfo;
}

export type TaskReadView = "full" | "overview" | "conversation";

const rpc = { timeoutMs: 10_000 };
const missing = (error: unknown) => error instanceof ConnectError && error.code === Code.NotFound;

/** Fresh authorized task metadata selects immutable terminal projections for reuse. */
export function taskRecords(clients: KagentClients) {
  const lineage = new LRUCache<string, TaskExecution>({ max: 4096 });
  async function nativeExecution({ summary, session }: TaskRecord, subject: string) {
    const key = JSON.stringify([subject, session.agentId, session.id, summary.id]);
    const known = subject ? lineage.get(key) : undefined;
    if (known) return known;
    const { execution } = await clients.execution.getTaskExecution({ taskId: summary.id }, rpc);
    if (execution?.task?.taskId !== summary.id || execution.task.sessionId !== session.id)
      throw new ConnectError("Native task relationship unavailable", Code.FailedPrecondition);
    if (subject) lineage.set(key, execution);
    return execution;
  }
  async function hydrate(record: TaskRecord, subject: string) {
    const { summary, session } = record;
    const [task, execution] = await Promise.all([
      clients.a2a.getTask({ tenant: session.agentId, id: summary.id }, rpc),
      nativeExecution(record, subject),
    ]);
    if (
      task.id !== summary.id ||
      task.contextId !== session.id ||
      execution?.task?.taskId !== task.id ||
      execution.task.sessionId !== task.contextId
    )
      throw new ConnectError("Native task relationship unavailable", Code.FailedPrecondition);
    return ingest(task, session.agentId, execution);
  }
  const completed = new LRUCache<string, TaskEntry>({
    max: 1024,
    maxSize: 32 * 1024 * 1024,
    sizeCalculation: (entry) => serialize(entry).byteLength,
  });

  async function read(record: TaskRecord, subject: string) {
    const { summary, session } = record;
    const key = JSON.stringify([subject, session.agentId, session.id, summary.id, summary.version]);
    const reusable = subject !== "" && terminal(summary.state);
    const cached = reusable ? completed.get(key) : undefined;
    const entry = cached ?? (await hydrate(record, subject));
    if (!cached && reusable && terminal(entry.state)) completed.set(key, entry);
    return entry;
  }

  return {
    async list(sessions: SessionInfo[], skipUnreadable = false) {
      const records: TaskRecord[] = [];
      await pool(sessions, 16, async (session) => {
        const selected: TaskRecord[] = [];
        try {
          await eachPage(
            async (pageToken) => {
              const page = await clients.a2a.listTasks(
                {
                  tenant: session.agentId,
                  contextId: session.id,
                  pageSize: 100,
                  pageToken,
                  historyLength: 0,
                  includeArtifacts: false,
                },
                rpc,
              );
              return { items: page.tasks, token: page.nextPageToken };
            },
            (tasks) => {
              for (const task of tasks)
                if (task.contextId === session.id) {
                  const summary = ingest(task, session.agentId);
                  // Protobuf map ordering is independent of the task's content revision.
                  summary.version = digest(toJson(TaskSchema, task));
                  selected.push({ session, summary });
                }
            },
          );
          records.push(...selected);
        } catch (error) {
          if (!skipUnreadable || !missing(error)) throw error;
        }
      });
      return records;
    },
    async overview(
      records: TaskRecord[],
      subject = "",
      skipUnreadable = false,
      preserveSessionOrder = false,
    ) {
      const sessions = new Map<string, TaskRecord[]>();
      if (preserveSessionOrder)
        for (const record of records) {
          const items = sessions.get(record.session.id) ?? [];
          items.push(record);
          sessions.set(record.session.id, items);
        }
      const unordered = new Set(
        [...sessions.values()]
          .filter(
            (items) =>
              items.length > 1 && items.some((item) => item.summary.createdAt === undefined),
          )
          .flatMap((items) => items.map((item) => item.summary.id)),
      );
      const entries: (TaskEntry | undefined)[] = new Array(records.length);
      await pool(
        records.map((record, index) => ({ record, index })),
        8,
        async ({ record, index }) => {
          try {
            entries[index] =
              terminal(record.summary.state) && !unordered.has(record.summary.id)
                ? { ...record.summary, execution: await nativeExecution(record, subject) }
                : await read(record, subject);
          } catch (error) {
            if (!skipUnreadable || !missing(error)) throw error;
          }
        },
      );
      return entries.filter((entry): entry is TaskEntry => entry !== undefined);
    },
    async read(records: TaskRecord[], subject = "", skipUnreadable = false) {
      const entries: (TaskEntry | undefined)[] = new Array(records.length);
      await pool(
        records.map((record, index) => ({ record, index })),
        8,
        async ({ record, index }) => {
          try {
            entries[index] = await read(record, subject);
          } catch (error) {
            if (!skipUnreadable || !missing(error)) throw error;
          }
        },
      );
      return entries.filter((entry): entry is TaskEntry => entry !== undefined);
    },
  };
}
