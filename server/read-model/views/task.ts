import { create } from "@bufbuild/protobuf";
import type { ListTasksRequest } from "../../../gen/agentos/console/v1/console_service_pb.js";
import {
  InteractionKind,
  type TaskSummary,
  TaskSummarySchema,
} from "../../../gen/agentos/console/v1/task_pb.js";
import { ActivityState } from "../../../gen/agentos/execution/v1/state_pb.js";
import { shortTitle } from "../../../shared/title.js";
import { emptyTags, normalizeTags, type TaskTags } from "../../tasks/tags.js";
import { agentRef, systemRoles } from "../agents.js";
import type { TaskEntry } from "../entry.js";
import type { TaskIndex } from "../index.js";
import { type PageRequest, pageOf } from "../page.js";
import { awaiting, taskActivity, terminal } from "../state.js";
import { busy, foreground, outcomeState, type TaskTree, taskTree } from "../tree.js";
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
function initiator(index: TaskIndex, root: TaskEntry): TaskEntry | undefined {
  const parent = index.entry(index.relations().parents.get(root.id) ?? "");
  return parent && systemRoles.has(index.roleOf(parent.agentId)) ? parent : undefined;
}

export function taskSummary(index: TaskIndex, tree: TaskTree): TaskSummary {
  const prompt = initiator(index, tree.root)?.prompt || tree.root.prompt;
  return create(TaskSummarySchema, {
    id: tree.root.id,
    title: shortTitle(prompt) || tree.root.id,
    prompt,
    state: treeState(tree),
    updatedAt: stamp(tree.updatedAt),
    conversationContextId: initiator(index, tree.root)?.contextId ?? "",
    agent: agentRef(tree.root.agentId),
    contextId: tree.root.contextId,
    ...emptyTags(),
  });
}

/** Operations ordered by their latest activity, so moving work rises to the top. */
export function listTasks(
  index: TaskIndex,
  request: PageRequest &
    Partial<Pick<ListTasksRequest, "states" | "engineer" | "tags" | "systemOnly">>,
  metadata: ReadonlyMap<string, TaskTags> = new Map(),
) {
  const needle = request.query.trim().toLowerCase();
  const states = [...new Set(request.states ?? [])].sort((a, b) => a - b);
  const engineer = request.engineer ?? "";
  const tags = normalizeTags(request.tags ?? []);
  const roots = index.relations().roots;
  const availableTags = [
    ...new Set(roots.flatMap((root) => metadata.get(root.id)?.tags ?? [])),
  ].sort();
  const matches = roots
    .filter((root) => {
      if (!needle) return true;
      const prompt = initiator(index, root)?.prompt || root.prompt;
      return `${prompt} ${root.id} ${(metadata.get(root.id)?.tags ?? []).join(" ")}`
        .toLowerCase()
        .includes(needle);
    })
    .filter((root) => tags.every((tag) => metadata.get(root.id)?.tags.includes(tag)))
    .flatMap((root) => taskTree(index, root.id) ?? [])
    .filter((tree) => !states.length || states.includes(treeState(tree)))
    .filter((tree) => !engineer || tree.entries.some((entry) => entry.agentId === engineer))
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || a.root.id.localeCompare(b.root.id));
  const page = pageOf(
    matches,
    request,
    `tasks:${JSON.stringify([states, engineer, tags, request.systemOnly === true])}`,
    (tree) => ({
      id: tree.root.id,
      time: tree.updatedAt ?? 0,
    }),
  );
  return {
    tasks: page.items.map((tree) =>
      Object.assign(taskSummary(index, tree), metadata.get(tree.root.id)),
    ),
    totalSize: page.totalSize,
    nextPageToken: page.nextPageToken,
    availableTags,
  };
}
