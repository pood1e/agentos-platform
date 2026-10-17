import { create } from "@bufbuild/protobuf";
import { type TaskRun, TaskRunSchema } from "../../../gen/agentos/console/v1/task_pb.js";
import { toolCalls } from "../calls.js";
import { approvals } from "../interactions.js";
import type { KagentSync } from "../sync.js";
import { runState, stamp } from "./runs.js";

/** One run with prompt, output and complete tool calls for the detail drawer. */
export async function taskRun(sync: KagentSync, taskId: string): Promise<TaskRun | undefined> {
  const entry = sync.index.entry(taskId);
  const task = entry && (await sync.fullTask(taskId));
  if (!entry || !task) return undefined;
  return create(TaskRunSchema, {
    taskId,
    agentId: entry.agentId,
    contextId: entry.contextId,
    state: runState(entry),
    prompt: entry.prompt,
    output: entry.answer,
    calls: toolCalls(task, entry.agentId, approvals(task)),
    updatedAt: stamp(entry.statusAt),
  });
}
