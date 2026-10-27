// Delete once kagent dedicated subagents propagate nested HITL decisions to the caller.
import { create } from "@bufbuild/protobuf";
import { MessageSchema, Role, TaskState } from "../../gen/a2a_pb.js";
import { CoordinationJobSchema } from "../../gen/agentos/execution/v1/coordination_pb.js";
import type { Coordinator } from "../jobs/coordination.js";
import { hitlExtension } from "../read-model/decode/hitl.js";
import { parentTaskKey, resumedTaskKey } from "../read-model/decode/messages.js";
import type { TaskEntry } from "../read-model/entry.js";
import type { TaskGraph } from "../read-model/graph.js";
import type { TaskProjection } from "../read-model/projection.js";
import { terminal } from "../read-model/state.js";
import { foreground, taskTree } from "../read-model/tree.js";
import { waitingDelegations } from "../read-model/waiting.js";

const resultMessage = (state: TaskState, task: string, result: string) =>
  `The delegated task ${task} finished with state ${TaskState[state]}.\nResult:\n${result}\n` +
  "Continue the original goal, verify missing evidence and report actual outcomes briefly in the original language.";

function stoppedOperation(graph: TaskGraph, parent: TaskEntry): boolean {
  const tree = taskTree(graph, parent.id);
  if (tree && foreground(tree).some((entry) => entry.state === TaskState.CANCELED)) return true;
  const ancestors = graph.relations().causalParents;
  const seen = new Set<string>();
  for (let entry: TaskEntry | undefined = parent; entry && !seen.has(entry.id); ) {
    if ([TaskState.CANCELED, TaskState.REJECTED].includes(entry.state)) return true;
    seen.add(entry.id);
    entry = graph.entry(ancestors.get(entry.id) ?? "");
  }
  return false;
}

function continuation(graph: TaskGraph, parent: TaskEntry, childId: string) {
  const { resumed } = graph.relations();
  const child = graph.entry(childId);
  if (!child || !terminal(child.state) || resumed.has(child.id)) return undefined;
  const tree = taskTree(graph, child.id);
  const active = tree ? foreground(tree) : [];
  if (active.some((entry) => !terminal(entry.state))) return undefined;
  if (active.some((entry) => waitingDelegations(graph, entry).some((id) => !resumed.has(id))))
    return undefined;
  const decided = active
    .filter((entry) => entry.decision)
    .sort((a, b) => (b.statusAt ?? 0) - (a.statusAt ?? 0))[0]?.decision;
  const result = tree?.latest ?? child;
  return create(MessageSchema, {
    messageId: `resume-${child.id}-${decided?.messageId ?? result.id}`,
    contextId: parent.contextId,
    role: Role.USER,
    extensions: [hitlExtension],
    metadata: { [parentTaskKey]: parent.id, [resumedTaskKey]: child.id },
    parts: [
      { content: { case: "text", value: resultMessage(result.state, result.id, result.answer) } },
    ],
  });
}

/** Returns nested HITL outcomes using kagent's idempotent message identity. */
export function continuations(
  projection: Pick<TaskProjection, "graphOf" | "send">,
  authorize?: (parentContext: string, contexts: string[]) => Promise<void>,
): Coordinator {
  return {
    name: "continuations",
    select(graph, changed) {
      const ids = new Set(changed);
      const parents = graph.relations().causalParents;
      for (const id of changed) {
        const parent = parents.get(id);
        if (parent) ids.add(parent);
      }
      return [...ids].flatMap((id) => {
        const parent = graph.entry(id);
        if (!parent || !terminal(parent.state) || stoppedOperation(graph, parent)) return [];
        return waitingDelegations(graph, parent).flatMap((childId) =>
          continuation(graph, parent, childId)
            ? [
                create(CoordinationJobSchema, {
                  taskId: parent.id,
                  work: { case: "childId", value: childId },
                }),
              ]
            : [],
        );
      });
    },
    async run(reference) {
      if (reference.work.case !== "childId") return;
      const childId = reference.work.value;
      const ready = async () => {
        const graph = await projection.graphOf({ taskId: reference.taskId });
        const parent = graph?.entry(reference.taskId);
        if (!graph || !parent || stoppedOperation(graph, parent)) return undefined;
        const message = continuation(graph, parent, childId);
        return message && { graph, parent, message };
      };
      const first = await ready();
      if (!first) return;
      await authorize?.(
        first.parent.contextId,
        (taskTree(first.graph, childId)?.entries ?? []).map((entry) => entry.contextId),
      );
      // Authorization and native lifecycle are checked again after an offline grant refresh.
      const next = await ready();
      if (next) await projection.send(next.parent.agentId, next.message);
    },
  };
}
