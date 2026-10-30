import { create } from "@bufbuild/protobuf";
import {
  type TaskRun,
  TaskRunSchema,
  ToolCallSchema,
} from "../../../gen/agentos/execution/v1/task_pb.js";
import { toolCalls } from "../calls.js";
import type { TaskEntry } from "../entry.js";
import { approvals } from "../interactions.js";
import { terminal } from "../state.js";
import type { FullTask } from "./conversation.js";
import { runState, runSummary, stamp } from "./runs.js";

/** Compact engineer work record with the latest narration and call status. */
export function engineerRun(entry: TaskEntry, background: boolean): TaskRun {
  const run = runSummary(entry, background);
  run.prompt = entry.prompt;
  run.output = terminal(entry.state) ? entry.answer : "";
  run.progress = terminal(entry.state) ? "" : entry.progress || entry.answer;
  run.calls = entry.calls.map((call) =>
    create(ToolCallSchema, {
      id: call.id,
      taskId: entry.id,
      agentId: entry.agentId,
      name: call.name,
      intent: call.intent,
      state: call.state,
      startedAt: stamp(call.startedAt),
      endedAt: stamp(call.endedAt),
    }),
  );
  return run;
}

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
