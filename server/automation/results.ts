import { create, fromJson, type JsonValue, toJson } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import {
  type GetScheduledRunExecutionResultRequest,
  GetScheduledRunExecutionResultResponseSchema,
} from "../../gen/agentos/automation/v1/service_pb.js";
import { TaskRunSchema } from "../../gen/agentos/execution/v1/task_pb.js";
import { redact } from "../../shared/redact.js";
import type { KagentClients } from "../kagent/clients.js";
import type { KagentSync } from "../read-model/sync.js";
import { taskRun } from "../read-model/views/run.js";

/** Reads only the original firing's task tree, excluding later conversation turns. */
export async function scheduledExecutionResult(
  clients: KagentClients,
  sync: KagentSync,
  workspace: string,
  request: GetScheduledRunExecutionResultRequest,
  authorize: (scheduleId: string) => Promise<void>,
  signal?: AbortSignal,
) {
  const { execution } = await clients.schedules.getScheduledRunExecution(
    { executionId: request.executionId },
    { signal, timeoutMs: 15_000 },
  );
  if (!execution) throw new ConnectError("Execution not found", Code.NotFound);
  await authorize(execution.scheduledRunId);
  const { scheduledRun } = await clients.schedules.getScheduledRun(
    { scheduledRunId: execution.scheduledRunId },
    { signal, timeoutMs: 15_000 },
  );
  if (scheduledRun?.agent?.namespace !== workspace)
    throw new ConnectError("Execution not found", Code.NotFound);
  if (!sync.healthy()) throw new ConnectError("History is synchronizing", Code.Unavailable);
  const root = execution.taskId ? sync.index.entry(execution.taskId) : undefined;
  if (execution.taskId && (!root || root.contextId !== execution.sessionId))
    throw new ConnectError("Execution history is unavailable", Code.Unavailable);
  const parents = sync.index.relations().causalParents;
  const belongs = (id: string) => {
    const seen = new Set<string>();
    for (
      let current: string | undefined = id;
      current && !seen.has(current);
      current = parents.get(current)
    ) {
      if (current === root?.id) return true;
      seen.add(current);
    }
    return false;
  };
  const ordered = root
    ? sync.index
        .all()
        .filter((entry) => belongs(entry.id) && !entry.reviewOfTaskId)
        .sort((a, b) => a.id.localeCompare(b.id))
    : [];
  const token = request.page?.pageToken ?? "";
  const offset = token ? ordered.findIndex((entry) => entry.id === token) + 1 : 0;
  if (token && offset === 0) throw new ConnectError("Invalid result cursor", Code.InvalidArgument);
  const limit = Math.min(Math.max(request.page?.limit || 20, 1), 50);
  const page = ordered.slice(offset, offset + limit);
  const runs = [];
  for (const entry of page) {
    signal?.throwIfAborted();
    const run = await taskRun(sync, entry.id);
    if (!run) throw new ConnectError("Execution history is unavailable", Code.Unavailable);
    runs.push(fromJson(TaskRunSchema, redact(toJson(TaskRunSchema, run) as JsonValue)));
  }
  const response = create(GetScheduledRunExecutionResultResponseSchema, {
    execution,
    runs,
    page: { nextPageToken: offset + page.length < ordered.length ? page.at(-1)?.id : "" },
  });
  if (
    Buffer.byteLength(
      JSON.stringify(toJson(GetScheduledRunExecutionResultResponseSchema, response)),
    ) >
    2 * 1024 * 1024
  )
    throw new ConnectError("Execution result exceeds the response limit", Code.ResourceExhausted);
  return response;
}
