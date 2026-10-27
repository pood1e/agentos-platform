import { create } from "@bufbuild/protobuf";
import { type TaskRun, TaskRunSchema } from "../../../gen/agentos/execution/v1/task_pb.js";
import { toolCalls } from "../calls.js";
import type { TaskEntry } from "../entry.js";
import { approvals } from "../interactions.js";
import type { FullTask } from "./conversation.js";
import { runState, stamp } from "./runs.js";

/** One run with prompt, output and complete tool calls for the detail drawer. */
export async function taskRun(
  entry: TaskEntry | undefined,
  fullTask: FullTask,
): Promise<TaskRun | undefined> {
  const task = entry && (await fullTask(entry));
  if (!entry || !task) return undefined;
  return create(TaskRunSchema, {
    taskId: entry.id,
    agentId: entry.agentId,
    contextId: entry.contextId,
    state: runState(entry),
    prompt: entry.prompt,
    output: entry.answer,
    calls: toolCalls(task, entry.agentId, approvals(task)),
    startedAt: stamp(entry.createdAt),
    updatedAt: stamp(entry.statusAt),
  });
}
