import { TaskState } from "../../gen/a2a_pb.js";
import { ActivityState } from "../../gen/agentos/execution/v1/state_pb.js";
import type { TaskEntry } from "./entry.js";
import type { TaskIndex } from "./index.js";

export const waitingDelegations = (index: TaskIndex, entry: TaskEntry) =>
  entry.calls.flatMap((call) => {
    const invocation = call.delegation?.invocation;
    const childId = invocation?.taskId || index.target(entry, call);
    if (!childId) return [];
    if (!invocation && (call.state === ActivityState.FAILED || !call.returned)) return [childId];
    if (!invocation) return [];
    if (invocation.state === TaskState.INPUT_REQUIRED) return [invocation.taskId];
    const child = index.entry(invocation.taskId);
    const continued =
      child &&
      (index.relations().continuations.get(child.id) ?? []).some((id) => {
        const next = index.entry(id);
        return (
          next?.agentId === child.agentId &&
          next.contextId === child.contextId &&
          next.resumedTaskId
        );
      });
    return continued ? [invocation.taskId] : [];
  });
