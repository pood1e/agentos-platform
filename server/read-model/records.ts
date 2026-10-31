import { serialize } from "node:v8";
import { toJson } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { LRUCache } from "lru-cache";
import { TaskSchema } from "../../gen/a2a_pb.js";
import { digest } from "../../shared/digest.js";
import { eachPage, type KagentClients, pool } from "../kagent/clients.js";
import type { SessionInfo } from "./agents.js";
import { ingest, type TaskEntry } from "./entry.js";
import { terminal } from "./state.js";

export interface TaskRecord {
  summary: TaskEntry;
  session: SessionInfo;
}

const rpc = { timeoutMs: 10_000 };
const missing = (error: unknown) => error instanceof ConnectError && error.code === Code.NotFound;

/** Fresh authorized task metadata selects immutable terminal projections for reuse. */
export function taskRecords(clients: KagentClients) {
  async function hydrate({ summary, session }: TaskRecord) {
    const [task, { execution }] = await Promise.all([
      clients.a2a.getTask({ tenant: session.agentId, id: summary.id }, rpc),
      clients.execution.getTaskExecution({ taskId: summary.id }, rpc),
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
    async read(records: TaskRecord[], subject = "", skipUnreadable = false) {
      const entries: (TaskEntry | undefined)[] = new Array(records.length);
      await pool(
        records.map((record, index) => ({ record, index })),
        8,
        async ({ record, index }) => {
          try {
            const { summary, session } = record;
            const key = JSON.stringify([
              subject,
              session.agentId,
              session.id,
              summary.id,
              summary.version,
            ]);
            const reusable = subject !== "" && terminal(summary.state);
            const cached = reusable ? completed.get(key) : undefined;
            const entry = cached ?? (await hydrate(record));
            if (!cached && reusable && terminal(entry.state)) completed.set(key, entry);
            entries[index] = entry;
          } catch (error) {
            if (!skipUnreadable || !missing(error)) throw error;
          }
        },
      );
      return entries.filter((entry): entry is TaskEntry => entry !== undefined);
    },
  };
}
