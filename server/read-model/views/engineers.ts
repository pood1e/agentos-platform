import { create } from "@bufbuild/protobuf";
import { type Engineer, EngineerSchema } from "../../../gen/agentos/console/v1/engineer_pb.js";
import { ActivityState } from "../../../gen/agentos/execution/v1/state_pb.js";
import { type AgentInfo, systemRoles } from "../agents.js";
import type { TaskEntry } from "../entry.js";
import type { TaskGraph } from "../graph.js";
import { interrupted, terminal } from "../state.js";
import { pendingApproval, running } from "./runs.js";

/** An agent's work within one viewer's executions. */
export interface AgentActivity {
  active: number;
  calls: number;
  working: boolean;
  approval: boolean;
  interrupted: boolean;
}

const idle: AgentActivity = {
  active: 0,
  calls: 0,
  working: false,
  approval: false,
  interrupted: false,
};

function engineerState(agent: AgentInfo | undefined, activity: AgentActivity): ActivityState {
  if (!agent) return ActivityState.UNOBSERVED;
  if (!agent.ready) return ActivityState.UNAVAILABLE;
  if (activity.working) return ActivityState.WORKING;
  if (activity.approval) return ActivityState.AWAITING_APPROVAL;
  if (activity.interrupted) return ActivityState.AWAITING_INPUT;
  return activity.active ? ActivityState.UNOBSERVED : ActivityState.IDLE;
}

/** Unknown IDs are agents reported only by the runtime. */
function engineerOf(agent: AgentInfo | undefined, id: string, activity: AgentActivity): Engineer {
  return create(EngineerSchema, {
    id,
    name: agent?.displayName || (agent ? "" : (id.split("/").at(-1) ?? id)),
    role: agent?.role ?? "",
    description: agent?.description ?? "",
    state: engineerState(agent, activity),
    unavailableReason: agent?.reason ?? "",
    unavailableMessage: agent?.message ?? "",
    activeTasks: activity.active,
    toolCalls: activity.calls,
  });
}

/** Engineer view over the given tasks of one execution tree. */
export function engineer(graph: TaskGraph, id: string, entries: TaskEntry[]): Engineer {
  const active = entries.filter((entry) => !terminal(entry.state));
  return engineerOf(graph.agent(id), id, {
    active: active.length,
    calls: entries.reduce((count, entry) => count + entry.calls.length, 0),
    working: active.some(running),
    approval: active.some(pendingApproval),
    interrupted: active.some((entry) => interrupted(entry.state)),
  });
}

export function engineers(agents: AgentInfo[], activity: ReadonlyMap<string, AgentActivity>) {
  return agents
    .filter((agent) => !agent.workflow && !systemRoles.has(agent.role))
    .map((agent) => engineerOf(agent, agent.id, activity.get(agent.id) ?? idle));
}
