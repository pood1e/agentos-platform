import { create } from "@bufbuild/protobuf";
import type { ListTasksRequest } from "../../../gen/agentos/console/v1/console_service_pb.js";
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
import { ActivityState } from "../../../gen/agentos/execution/v1/state_pb.js";
import { SessionSchema } from "../../../gen/kagent/api/v1alpha1/sessions_pb.js";
import { shortTitle } from "../../../shared/title.js";
import { emptyTags, normalizeTags, type TaskTags } from "../../tasks/tags.js";
import { systemRoles } from "../agents.js";
import type { TaskEntry } from "../entry.js";
import type { TaskIndex } from "../index.js";
import { type PageRequest, pageOf } from "../page.js";
import { awaiting, taskActivity, terminal } from "../state.js";
import { busy, foreground, outcomeState, type TaskTree, taskTree } from "../tree.js";
import { engineer } from "./engineers.js";
import { reviewDelegations } from "./reviews.js";
import { runState, runSummary, stamp } from "./runs.js";

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
  return running ? runState(running) : taskActivity(outcomeState(tree));
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
    ...emptyTags(),
  });
}

/** Operations ordered by their latest activity, so moving work rises to the top. */
export function listTasks(
  index: TaskIndex,
  request: PageRequest & Partial<Pick<ListTasksRequest, "states" | "engineer" | "tags">>,
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
    `tasks:${JSON.stringify([states, engineer, tags])}`,
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
          sourceContextId: entry.contextId,
          targetContextId: child?.contextId || ref.sessionId,
          callId: call.id,
          state: child ? runState(child) : call.state,
          startedAt: stamp(call.startedAt),
          returnedAt: ref.kind === DelegationKind.BACKGROUND ? undefined : stamp(call.endedAt),
          finishedAt: child && terminal(child.state) ? stamp(child.statusAt) : undefined,
          dependsOn: call.dependsOn.map((id) => `call:${entry.id}:${id}`),
          returned: ref.kind === DelegationKind.INVOKE && call.returned,
        }),
      ];
    });
    const parent = byId.get(index.relations().parents.get(entry.id) ?? "");
    const previous =
      byId.get(entry.resumedTaskId) ??
      (parent?.agentId === entry.agentId && parent.contextId === entry.contextId
        ? parent
        : undefined);
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
        sourceContextId: previous.contextId,
        targetContextId: entry.contextId,
        state: runState(entry),
        startedAt: stamp(previous.statusAt),
        finishedAt: done ? stamp(entry.statusAt) : undefined,
      }),
    ];
  });
}

export function taskDetail(index: TaskIndex, rootId: string): TaskDetail | undefined {
  const root = index.operationRoot(rootId);
  const tree = root && taskTree(index, root.id);
  if (!tree) return undefined;
  const links = [...delegations(index, tree), ...reviewDelegations(tree)];
  const agentIds = new Set([
    ...tree.entries.map((entry) => entry.agentId),
    ...links.map((link) => link.targetAgentId),
  ]);
  const contexts = new Map(tree.entries.map((entry) => [entry.contextId, entry.agentId]));
  for (const link of links)
    if (link.targetContextId) contexts.set(link.targetContextId, link.targetAgentId);
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
    sessions: [...contexts]
      .filter(([id]) => id)
      .map(([id, agentId]) => {
        const session = index.session(id);
        const [namespace, name] = agentId.split("/");
        return create(SessionSchema, {
          id,
          contextId: id,
          agent: { namespace, name },
          name: session?.name ?? "",
          updatedAt: stamp(session?.updatedAt),
        });
      }),
    interactions: tree.entries.flatMap((entry) => entry.interactions),
    runs: tree.entries.map((entry) => runSummary(entry, tree.background.has(entry.id))),
    answer: tree.latest.answer,
    startedAt: stamp(tree.root.createdAt),
    completedAt:
      !busy(tree) && terminal(tree.latest.state) ? stamp(tree.latest.statusAt) : undefined,
  });
}
