import { create } from "@bufbuild/protobuf";
import { type AgentSummary, AgentSummarySchema } from "../../../gen/agentos/console/v1/agent_pb.js";
import { ActivityState } from "../../../gen/agentos/execution/v1/state_pb.js";
import { agentRef } from "../../kagent/resources.js";
import type { AgentInfo } from "../agents.js";
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

function agentState(agent: AgentInfo | undefined, activity: AgentActivity): ActivityState {
  if (!agent) return ActivityState.UNOBSERVED;
  if (!agent.ready) return ActivityState.UNAVAILABLE;
  if (activity.working) return ActivityState.WORKING;
  if (activity.approval) return ActivityState.AWAITING_APPROVAL;
  if (activity.interrupted) return ActivityState.AWAITING_INPUT;
  return activity.active ? ActivityState.UNOBSERVED : ActivityState.IDLE;
}

/** Unknown IDs are agents reported only by the runtime. */
function summaryOf(
  agent: AgentInfo | undefined,
  id: string,
  activity: AgentActivity,
): AgentSummary {
  return create(AgentSummarySchema, {
    id,
    name: agent?.displayName || (agent ? "" : (id.split("/").at(-1) ?? id)),
    template: agent?.templateName
      ? agentRef(`${id.split("/")[0]}/${agent.templateName}`)
      : undefined,
    description: agent?.description ?? "",
    state: agentState(agent, activity),
    unavailableReason: agent?.reason ?? "",
    unavailableMessage: agent?.message ?? "",
    activeTasks: activity.active,
    toolCalls: activity.calls,
  });
}

/** AgentSummary view over the given tasks of one execution tree. */
export function agentSummary(graph: TaskGraph, id: string, entries: TaskEntry[]): AgentSummary {
  const active = entries.filter((entry) => !terminal(entry.state));
  return summaryOf(graph.agent(id), id, {
    active: active.length,
    calls: entries.reduce((count, entry) => count + entry.calls.length, 0),
    working: active.some(running),
    approval: active.some(pendingApproval),
    interrupted: active.some((entry) => interrupted(entry.state)),
  });
}

export function agentSummaries(agents: AgentInfo[], activity: ReadonlyMap<string, AgentActivity>) {
  return agents.map((agent) => summaryOf(agent, agent.id, activity.get(agent.id) ?? idle));
}
