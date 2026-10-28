import { create } from "@bufbuild/protobuf";
import {
  InteractionKind,
  type TaskSummary,
  TaskSummarySchema,
} from "../../../gen/agentos/console/v1/task_pb.js";
import { ActivityState } from "../../../gen/agentos/execution/v1/state_pb.js";
import { shortTitle } from "../../../shared/title.js";
import { agentRef, systemRoles } from "../agents.js";
import type { TaskEntry } from "../entry.js";
import type { TaskGraph } from "../graph.js";
import { awaiting, taskActivity, terminal } from "../state.js";
import { busy, foreground, outcomeState, type TaskTree } from "../tree.js";
import { runState, stamp } from "./runs.js";

function treeState(tree: TaskTree): ActivityState {
  const active = foreground(tree);
  const pending = active.flatMap((entry) =>
    entry.interactions.filter((item) => awaiting(item.state)),
  );
  if (pending.length)
    return pending.some((item) => item.kind === InteractionKind.APPROVAL)
      ? ActivityState.AWAITING_APPROVAL
      : ActivityState.AWAITING_INPUT;
  const running = active.find((entry) => !terminal(entry.state));
  return running
    ? runState(running)
    : busy(tree)
      ? ActivityState.WORKING
      : taskActivity(outcomeState(tree));
}

/** The chat request that started this operation, when it was delegated from a conversation. */
function initiator(graph: TaskGraph, root: TaskEntry): TaskEntry | undefined {
  const parent = graph.entry(graph.relations().parents.get(root.id) ?? "");
  return parent && systemRoles.has(graph.roleOf(parent.agentId)) ? parent : undefined;
}

export function taskSummary(graph: TaskGraph, tree: TaskTree): TaskSummary {
  const prompt = initiator(graph, tree.root)?.prompt || tree.root.prompt;
  return create(TaskSummarySchema, {
    id: tree.root.id,
    title: shortTitle(prompt) || tree.root.id,
    prompt,
    state: treeState(tree),
    updatedAt: stamp(tree.updatedAt),
    conversationContextId: initiator(graph, tree.root)?.contextId ?? "",
    agent: agentRef(tree.root.agentId),
    contextId: tree.root.contextId,
  });
}
