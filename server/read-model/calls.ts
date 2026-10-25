import { create, fromJson, type JsonValue } from "@bufbuild/protobuf";
import { timestampFromMs, ValueSchema } from "@bufbuild/protobuf/wkt";
import type { Task } from "../../gen/a2a_pb.js";
import { DelegationKind } from "../../gen/agentos/console/v1/task_pb.js";
import { ActivityState } from "../../gen/agentos/execution/v1/state_pb.js";
import { type ToolCall, ToolCallSchema } from "../../gen/agentos/execution/v1/task_pb.js";
import { hitlPayload } from "./decode/hitl.js";
import { intentKey, taskSources, text, timeline } from "./decode/messages.js";
import {
  type DelegationRef,
  delegationRef,
  structured,
  type ToolEvent,
  toolBaseName,
  toolEvent,
  toolEventId,
  toolOutcome,
} from "./decode/tools.js";
import { taskActivity, terminal } from "./state.js";

export type Approval = "pending" | "approved" | "rejected" | "failed" | "abandoned";

interface Draft {
  id: string;
  name: string;
  intent: string;
  args?: JsonValue;
  responses: JsonValue[];
  dependsOn: string[];
  startedAt?: number;
  endedAt?: number;
}

export interface CallEntry {
  id: string;
  name: string;
  intent: string;
  state: ActivityState;
  startedAt?: number;
  endedAt?: number;
  delegation?: DelegationRef;
  dependsOn: string[];
  returned: boolean;
}

function drafts(task: Task): Draft[] {
  const calls = new Map<string, Draft>();
  const sources = taskSources(task);
  const interruptions = new Set(
    task.history
      .filter((message) => hitlPayload(message))
      .map((message) => `message:${message.messageId}`),
  );
  let narration = "";
  const replies = new Set<string>();
  const observed = new Set<string>();
  for (const source of sources) {
    if (interruptions.has(source.key)) continue;
    for (const [index, part] of source.parts.entries()) {
      if (part.content.case === "text") {
        if (source.narration) narration += part.content.value;
        continue;
      }
      const event: ToolEvent | undefined = toolEvent(part);
      if (!event) continue;
      // Events without an ID stay separate; a tool name cannot identify concurrent calls.
      const id = toolEventId(event, source.key, index);
      const previous = calls.get(id);
      const name = event.name || previous?.name || "";
      if (toolBaseName(name) === "adk_request_confirmation") continue;
      const call = previous ?? { id, name, intent: "", responses: [], dependsOn: [] };
      const at = timeline(part.metadata) ?? source.at;
      if (event.kind === "function_call") {
        if (!previous) call.dependsOn = [...replies];
        call.args = event.args;
        call.intent = text(part.metadata?.[intentKey]) || narration.trim() || call.intent;
        call.startedAt = at;
        narration = "";
      } else {
        call.responses.push(event.response ?? null);
        call.endedAt = at;
        if (delegationRef(call)?.kind === DelegationKind.INVOKE && !observed.has(id)) {
          observed.add(id);
          for (const dependency of call.dependsOn) replies.delete(dependency);
          replies.add(id);
        }
      }
      calls.set(id, call);
    }
  }
  return [...calls.values()];
}

// ADK answers an approval-gated call with a confirmation error before the human decision.
const effectiveResponses = (call: Draft, approval?: Approval) =>
  approval === "approved"
    ? call.responses.length > 1
      ? call.responses.slice(1)
      : call.responses.filter((response) => toolOutcome(response).kind === "output")
    : call.responses;

function resolve(call: Draft, task: Task, approval?: Approval) {
  const last = effectiveResponses(call, approval).at(-1);
  const outcome = last === undefined ? undefined : toolOutcome(last);
  const delegation = delegationRef(call, outcome?.kind === "output" ? outcome.value : undefined);
  let state: ActivityState;
  if (approval === "pending") state = ActivityState.AWAITING_APPROVAL;
  else if (approval === "rejected") state = ActivityState.REJECTED;
  else if (approval === "failed") state = ActivityState.FAILED;
  else if (approval === "abandoned") state = ActivityState.CANCELED;
  else if (!outcome)
    state = terminal(task.status?.state) ? ActivityState.UNOBSERVED : ActivityState.WORKING;
  else if (outcome.kind === "pending") state = ActivityState.AWAITING_INPUT;
  else if (outcome.kind === "error") state = ActivityState.FAILED;
  else if (delegation?.invocation) state = taskActivity(delegation.invocation.state);
  else state = ActivityState.SUCCEEDED;
  return { state, outcome, delegation };
}

export function callEntries(task: Task, approvals: Map<string, Approval>): CallEntry[] {
  return drafts(task).map((call) => {
    const { state, delegation } = resolve(call, task, approvals.get(call.id));
    return {
      id: call.id,
      name: call.name,
      intent: call.intent,
      state,
      startedAt: call.startedAt,
      endedAt: call.endedAt,
      delegation,
      dependsOn: call.dependsOn,
      returned: call.responses.length > 0,
    };
  });
}

const value = (json: JsonValue | undefined) =>
  json === undefined ? undefined : fromJson(ValueSchema, json);
const stamp = (ms?: number) => (ms === undefined ? undefined : timestampFromMs(ms));

/** Calls with arguments and results for one run's detail view. */
export function toolCalls(
  task: Task,
  agentId: string,
  approvals: Map<string, Approval>,
): ToolCall[] {
  return drafts(task).map((call) => {
    const { state, outcome } = resolve(call, task, approvals.get(call.id));
    return create(ToolCallSchema, {
      id: call.id,
      taskId: task.id,
      agentId,
      name: call.name,
      intent: call.intent,
      state,
      startedAt: stamp(call.startedAt),
      endedAt: stamp(call.endedAt),
      args: value(call.args),
      output: value(outcome ? structured(outcome.value) : undefined),
    });
  });
}
