import { create } from "@bufbuild/protobuf";
import { type Engineer, EngineerSchema } from "../../../gen/agentos/console/v1/engineer_pb.js";
import { ActivityState } from "../../../gen/agentos/execution/v1/state_pb.js";
import { type AgentInfo, systemRoles } from "../agents.js";
import type { TaskEntry } from "../entry.js";
import type { TaskIndex } from "../index.js";
import { interrupted, terminal } from "../state.js";
import { pendingApproval } from "./runs.js";

function engineerState(agent: AgentInfo | undefined, active: TaskEntry[]): ActivityState {
  if (!agent) return ActivityState.UNOBSERVED;
  if (!agent.ready) return ActivityState.UNAVAILABLE;
  if (active.some(pendingApproval)) return ActivityState.AWAITING_APPROVAL;
  if (active.some((entry) => interrupted(entry.state))) return ActivityState.AWAITING_INPUT;
  return active.length ? ActivityState.WORKING : ActivityState.IDLE;
}

/** Engineer view over the given tasks; unknown IDs are agents reported only by the runtime. */
export function engineer(index: TaskIndex, id: string, entries: TaskEntry[]): Engineer {
  const agent = index.agent(id);
  const active = entries.filter((entry) => !terminal(entry.state));
  return create(EngineerSchema, {
    id,
    name: agent?.displayName || (agent ? "" : (id.split("/").at(-1) ?? id)),
    role: agent?.role ?? "",
    description: agent?.description ?? "",
    state: engineerState(agent, active),
    unavailableReason: agent?.reason ?? "",
    unavailableMessage: agent?.message ?? "",
    activeTasks: active.length,
    toolCalls: entries.reduce((count, entry) => count + entry.calls.length, 0),
  });
}

export function engineers(index: TaskIndex): Engineer[] {
  return index
    .agents()
    .filter((agent) => !systemRoles.has(agent.role))
    .map((agent) => engineer(index, agent.id, index.agentEntries(agent.id)));
}
