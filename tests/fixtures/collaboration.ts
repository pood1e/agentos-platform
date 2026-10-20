import { create } from "@bufbuild/protobuf";
import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import {
  DelegationKind,
  type Interaction,
  TaskDetailSchema,
} from "../../gen/agentos/console/v1/task_pb.js";
import { ActivityState } from "../../gen/agentos/execution/v1/state_pb.js";
import type { TaskRun } from "../../gen/agentos/execution/v1/task_pb.js";
import type { Link } from "../../src/features/tasks/flow/links.js";

const kinds = {
  invoke: DelegationKind.INVOKE,
  background: DelegationKind.BACKGROUND,
  handoff: DelegationKind.HANDOFF,
  resume: DelegationKind.RESUME,
  review: DelegationKind.REVIEW,
  approval: DelegationKind.UNSPECIFIED,
};
const stamp = (value?: number) => (value === undefined ? undefined : timestampFromMs(value));
export const root = { taskId: "root", agentId: "coordinator", contextId: "context-root" };
export const link = (id: string, fields: Partial<Link> = {}): Link => ({
  id,
  source: root.agentId,
  sourceTaskId: root.taskId,
  sourceContextId: root.contextId,
  target: id,
  targetTaskId: `task-${id}`,
  targetContextId: `context-${fields.target ?? id}`,
  kind: "invoke",
  state: ActivityState.SUCCEEDED,
  dependsOn: [],
  returned: true,
  ...fields,
});

export function collaborationDetail(
  links: Link[],
  options: {
    root?: typeof root | null;
    runs?: TaskRun[];
    interactions?: Interaction[];
    names?: Record<string, string>;
  } = {},
) {
  const origin = options.root === undefined ? root : options.root;
  const runs = new Map<
    string,
    {
      taskId: string;
      agentId: string;
      contextId: string;
      state: ActivityState;
      updatedAt?: ReturnType<typeof timestampFromMs>;
    }
  >();
  if (origin) runs.set(origin.taskId, { ...origin, state: ActivityState.SUCCEEDED });
  for (const link of links) {
    if (!runs.has(link.sourceTaskId))
      runs.set(link.sourceTaskId, {
        taskId: link.sourceTaskId,
        agentId: link.source,
        contextId: link.sourceContextId,
        state: ActivityState.SUCCEEDED,
      });
    if (link.targetTaskId)
      runs.set(link.targetTaskId, {
        taskId: link.targetTaskId,
        agentId: link.target,
        contextId: link.targetContextId,
        state: link.state,
        updatedAt: stamp(link.finishedAt ?? link.endedAt ?? link.startedAt),
      });
  }
  const contexts = new Map([...runs.values()].map((run) => [run.contextId, run.agentId]));
  for (const link of links)
    if (link.targetContextId) contexts.set(link.targetContextId, link.target);
  return create(TaskDetailSchema, {
    summary: origin ? { id: origin.taskId } : undefined,
    runs: options.runs ?? [...runs.values()],
    sessions: [...contexts]
      .filter(([id]) => id)
      .map(([id, agentId]) => ({
        id,
        contextId: id,
        name: options.names?.[id] ?? "",
        agent: { namespace: "workspace", name: agentId },
      })),
    interactions: options.interactions ?? [],
    delegations: links.map((link) => ({
      id: link.id,
      kind: kinds[link.kind],
      sourceAgentId: link.source,
      targetAgentId: link.target,
      sourceTaskId: link.sourceTaskId,
      targetTaskId: link.targetTaskId,
      sourceContextId: link.sourceContextId,
      targetContextId: link.targetContextId,
      callId: link.callKey?.split(":").at(-1),
      requestId: link.requestId,
      state: link.state,
      dependsOn: link.dependsOn,
      returned: link.returned,
      startedAt: stamp(link.startedAt),
      returnedAt: stamp(link.endedAt),
      finishedAt: stamp(link.finishedAt),
    })),
  });
}
