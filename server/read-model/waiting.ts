import { TaskState } from "../../gen/a2a_pb.js";
import { ActivityState } from "../../gen/agentos/execution/v1/state_pb.js";
import type { TaskEntry } from "./entry.js";
import type { TaskGraph } from "./graph.js";

export const waitingDelegations = (graph: TaskGraph, entry: TaskEntry) =>
  entry.calls.flatMap((call) => {
    const invocation = call.delegation?.invocation;
    const childId = invocation?.taskId || graph.target(entry, call);
    if (!childId) return [];
    if (!invocation && (call.state === ActivityState.FAILED || !call.returned)) return [childId];
    if (!invocation) return [];
    if (invocation.state === TaskState.INPUT_REQUIRED) return [invocation.taskId];
    const child = graph.entry(invocation.taskId);
    const continued =
      child &&
      (graph.relations().continuations.get(child.id) ?? []).some((id) => {
        const next = graph.entry(id);
        return (
          next?.agentId === child.agentId &&
          next.contextId === child.contextId &&
          next.resumedTaskId
        );
      });
    return continued ? [invocation.taskId] : [];
  });
