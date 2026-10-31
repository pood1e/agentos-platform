import { create } from "@bufbuild/protobuf";
import { ExecutionGraphSchema } from "../../../gen/agentos/console/v1/execution_pb.js";
import { InteractionSchema } from "../../../gen/agentos/console/v1/task_pb.js";
import type { TaskEntry } from "../entry.js";
import type { TaskGraph } from "../graph.js";
import { taskTree } from "../tree.js";
import { engineer } from "./engineers.js";
import { runSummary } from "./runs.js";

export function executionGraph(graph: TaskGraph, roots: readonly string[]) {
  const entries = new Map<string, TaskEntry>();
  const background = new Set<string>();
  for (const id of roots) {
    const tree = taskTree(graph, id);
    for (const entry of tree?.entries ?? []) entries.set(entry.id, entry);
    for (const child of tree?.background ?? []) background.add(child);
  }
  const selected = [...entries.values()];
  return create(ExecutionGraphSchema, {
    runs: selected.map((entry) => runSummary(entry, background.has(entry.id))),
    participants: [...new Set(selected.map((entry) => entry.agentId))].map((id) =>
      engineer(
        graph,
        id,
        selected.filter((entry) => entry.agentId === id),
      ),
    ),
    interactions: selected
      .flatMap((entry) => entry.interactions)
      .map((item) =>
        create(InteractionSchema, {
          id: item.id,
          taskId: item.taskId,
          agentId: item.agentId,
          kind: item.kind,
          state: item.state,
        }),
      ),
  });
}
