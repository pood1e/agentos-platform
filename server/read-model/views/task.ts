import { create } from "@bufbuild/protobuf";
import { ActivityState } from "../../../gen/agentos/console/v1/state_pb.js";
import {
  type Delegation,
  DelegationKind,
  DelegationSchema,
  InteractionKind,
  type TaskDetail,
  TaskDetailSchema,
  type TaskSummary,
  TaskSummarySchema,
} from "../../../gen/agentos/console/v1/task_pb.js";
import { systemRoles } from "../agents.js";
import type { TaskEntry } from "../entry.js";
import type { TaskIndex } from "../index.js";
import { type PageRequest, pageOf } from "../page.js";
import { awaiting, taskActivity, terminal } from "../state.js";
import { foreground, type TaskTree, taskTree } from "../tree.js";
import { engineer } from "./engineers.js";
import { reviewDelegations } from "./reviews.js";
import { runState, runSummary, stamp } from "./runs.js";
import { shortTitle } from "./title.js";

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
  return running ? runState(running) : taskActivity(tree.latest.state);
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
  });
}

/** Operations ordered by their latest activity, so moving work rises to the top. */
export function listTasks(index: TaskIndex, request: PageRequest) {
  const needle = request.query.trim().toLowerCase();
  const matches = index
    .relations()
    .roots.filter((root) => {
      if (!needle) return true;
      const prompt = initiator(index, root)?.prompt || root.prompt;
      return `${prompt} ${root.id}`.toLowerCase().includes(needle);
    })
    .flatMap((root) => taskTree(index, root.id) ?? [])
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || a.root.id.localeCompare(b.root.id));
  const page = pageOf(matches, request, "tasks", (tree) => ({
    id: tree.root.id,
    time: tree.updatedAt ?? 0,
  }));
  return {
    tasks: page.items.map((tree) => taskSummary(index, tree)),
    totalSize: page.totalSize,
    nextPageToken: page.nextPageToken,
  };
}

function delegations(index: TaskIndex, tree: TaskTree): Delegation[] {
  const byId = new Map(tree.entries.map((entry) => [entry.id, entry]));
  return tree.entries.flatMap((entry) => {
    const calls = entry.calls.flatMap((call): Delegation[] => {
      const ref = call.delegation;
      if (!ref) return [];
      const handoff = ref.kind === DelegationKind.HANDOFF;
      const child = byId.get(index.target(entry, call) ?? "");
      const target = handoff
        ? `${entry.agentId.split("/")[0]}/${ref.agentName}`
        : (child?.agentId ??
          index.session(ref.sessionId)?.agentId ??
          (ref.agentName ? `${entry.agentId.split("/")[0]}/${ref.agentName}` : ""));
      if (!target || (handoff && target === entry.agentId)) return [];
      return [
        create(DelegationSchema, {
          id: `call:${entry.id}:${call.id}`,
          kind: ref.kind,
          sourceAgentId: entry.agentId,
          targetAgentId: target,
          sourceTaskId: entry.id,
          targetTaskId: child?.id ?? "",
          callId: call.id,
          state: child ? runState(child) : call.state,
          startedAt: stamp(call.startedAt),
          returnedAt: ref.kind === DelegationKind.BACKGROUND ? undefined : stamp(call.endedAt),
          finishedAt: child && terminal(child.state) ? stamp(child.statusAt) : undefined,
        }),
      ];
    });
    const previous = byId.get(entry.resumedTaskId);
    if (!previous) return calls;
    const done = terminal(entry.state);
    return [
      ...calls,
      create(DelegationSchema, {
        id: `resume:${entry.id}`,
        kind: DelegationKind.RESUME,
        sourceAgentId: previous.agentId,
        targetAgentId: entry.agentId,
        sourceTaskId: previous.id,
        targetTaskId: entry.id,
        state: done ? ActivityState.SUCCEEDED : ActivityState.WORKING,
        startedAt: stamp(previous.statusAt),
        finishedAt: done ? stamp(entry.statusAt) : undefined,
      }),
    ];
  });
}

export function taskDetail(index: TaskIndex, rootId: string): TaskDetail | undefined {
  const tree = taskTree(index, rootId);
  if (!tree) return undefined;
  const links = [...delegations(index, tree), ...reviewDelegations(tree)];
  const agentIds = new Set([
    ...tree.entries.map((entry) => entry.agentId),
    ...links.map((link) => link.targetAgentId),
  ]);
  return create(TaskDetailSchema, {
    summary: taskSummary(index, tree),
    participants: [...agentIds].map((id) =>
      engineer(
        index,
        id,
        tree.entries.filter((entry) => entry.agentId === id),
      ),
    ),
    delegations: links,
    interactions: tree.entries.flatMap((entry) => entry.interactions),
    runs: tree.entries.map((entry) => runSummary(entry, tree.background.has(entry.id))),
    answer: tree.latest.answer,
    startedAt: stamp(tree.root.createdAt),
    completedAt: terminal(tree.latest.state) ? stamp(tree.latest.statusAt) : undefined,
  });
}
