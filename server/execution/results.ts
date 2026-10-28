import { create, fromJson, type JsonValue, toJson } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import {
  type GetExecutionRequest,
  GetExecutionResponseSchema,
} from "../../gen/agentos/execution/v1/service_pb.js";
import type { InvokeSessionOutput } from "../../gen/kagent/api/v1/collaboration_pb.js";
import { redact } from "../../shared/redact.js";
import type { TaskGraph } from "../read-model/graph.js";
import type { TaskQueries } from "../read-model/queries.js";
import { taskRun } from "../read-model/views/run.js";

/** Reads the requested task and its causal children, excluding later conversation turns. */
export async function executionResult(
  projection: Pick<TaskQueries, "fullTask">,
  graph: TaskGraph,
  rootId: string,
  execution: InvokeSessionOutput,
  request: GetExecutionRequest,
  signal?: AbortSignal,
) {
  const parents = graph.relations().causalParents;
  const belongs = (id: string) => {
    const seen = new Set<string>();
    for (
      let current: string | undefined = id;
      current && !seen.has(current);
      current = parents.get(current)
    ) {
      if (current === rootId) return true;
      seen.add(current);
    }
    return false;
  };
  const ordered = graph
    .all()
    .filter((entry) => belongs(entry.id))
    .sort((a, b) => a.id.localeCompare(b.id));
  const token = request.page?.pageToken ?? "";
  const offset = token ? ordered.findIndex((entry) => entry.id === token) + 1 : 0;
  if (token && offset === 0) throw new ConnectError("Invalid result cursor", Code.InvalidArgument);
  const limit = Math.min(Math.max(request.page?.limit || 20, 1), 50);
  const page = ordered.slice(offset, offset + limit);
  const runs = [];
  for (const entry of page) {
    signal?.throwIfAborted();
    const run = await taskRun(entry, projection.fullTask);
    if (!run) throw new ConnectError("Execution history is unavailable", Code.Unavailable);
    runs.push(run);
  }
  const response = create(GetExecutionResponseSchema, {
    execution,
    runs,
    page: { nextPageToken: offset + page.length < ordered.length ? page.at(-1)?.id : "" },
  });
  const json = redact(toJson(GetExecutionResponseSchema, response) as JsonValue);
  if (Buffer.byteLength(JSON.stringify(json)) > 2 * 1024 * 1024)
    throw new ConnectError("Execution result exceeds the response limit", Code.ResourceExhausted);
  return fromJson(GetExecutionResponseSchema, json);
}
