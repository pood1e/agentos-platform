import { create, fromJson, type JsonValue } from "@bufbuild/protobuf";
import { timestampFromMs, ValueSchema } from "@bufbuild/protobuf/wkt";
import { type Message, type Task, TaskState } from "../../gen/a2a_pb.js";
import {
  type Interaction,
  InteractionKind,
  InteractionSchema,
} from "../../gen/agentos/console/v1/task_pb.js";
import { ActivityState } from "../../gen/agentos/execution/v1/state_pb.js";
import type { HitlTool } from "../../gen/kagent/api/v1/interactions_pb.js";
import type { Approval, CallEntry } from "./calls.js";
import { approvalDecisions } from "./decode/approval-decisions.js";
import { type HitlPayload, hitlExtension, hitlPayload, isHitlResponse } from "./decode/hitl.js";
import { millis, object, timeline } from "./decode/messages.js";
import { toolBaseName } from "./decode/tools.js";

interface Request {
  message: Message;
  payload: Extract<HitlPayload, { type: "tool_approval_request" | "ask_user_request" }>;
  tools: HitlTool[];
  requestId: string;
  response?: Message;
  decisions: ReturnType<typeof approvalDecisions>;
  current: boolean;
  canceled: boolean;
}

function requests(task: Task): Request[] {
  const status = task.status?.message;
  const messages = [...task.history];
  if (status && !messages.some((message) => message.messageId === status.messageId))
    messages.push(status);
  return messages.flatMap((message): Request[] => {
    const payload = hitlPayload(message);
    if (payload?.type !== "tool_approval_request" && payload?.type !== "ask_user_request")
      return [];
    const nested = payload.value.nested?.tools ?? [];
    const tools = (
      payload.type === "tool_approval_request" && !nested.length ? payload.value.tools : nested
    ).filter((tool) => tool.id && tool.name);
    if (payload.type === "tool_approval_request" ? !tools.length : !payload.value.id) return [];
    const requestId =
      payload.type === "tool_approval_request"
        ? tools.map((tool) => tool.id).join(",")
        : payload.value.id;
    const response = task.history.find((reply) => {
      const answer = hitlPayload(reply);
      return payload.type === "tool_approval_request"
        ? answer?.type === "tool_approval_response" &&
            tools.every((tool) => answer.value.approvals.some((item) => item.id === tool.id))
        : answer?.type === "ask_user_response" && answer.value.id === requestId;
    });
    const current =
      task.status?.state === TaskState.INPUT_REQUIRED && message.messageId === status?.messageId;
    const canceled = task.status?.state === TaskState.CANCELED && !response;
    const decisions = approvalDecisions(response).filter((decision) =>
      tools.some((tool) => tool.id === decision.reference?.toolId),
    );
    return [{ message, payload, tools, requestId, response, decisions, current, canceled }];
  });
}

const approved = (request: Request) => {
  const answer = hitlPayload(request.response);
  return answer?.type === "tool_approval_response"
    ? answer.value.approvals.every((item) => item.approved)
    : false;
};

/** Human decision state per tool call ID, taken from native approval requests. */
export function approvals(task: Task): Map<string, Approval> {
  const result = new Map<string, Approval>();
  for (const request of requests(task)) {
    if (request.payload.type !== "tool_approval_request") continue;
    const answer = hitlPayload(request.response);
    for (const tool of request.tools) {
      if (!tool.callId) continue;
      const decision =
        answer?.type === "tool_approval_response"
          ? answer.value.approvals.find((item) => item.id === tool.id)
          : undefined;
      const status: Approval = decision
        ? decision.approved
          ? "approved"
          : request.decisions.some(
                (item) => item.reference?.toolId === tool.id && item.state === ActivityState.FAILED,
              )
            ? "failed"
            : "rejected"
        : request.current
          ? "pending"
          : "abandoned";
      result.set(tool.callId, status);
    }
  }
  return result;
}

const stamp = (ms?: number) => (ms === undefined ? undefined : timestampFromMs(ms));
const value = (args?: JsonValue) => (args === undefined ? undefined : fromJson(ValueSchema, args));

export function interactions(task: Task, agentId: string, calls: CallEntry[]): Interaction[] {
  const seen = new Set<string>();
  return requests(task).flatMap((request) => {
    const id = `${task.id}:human:${request.requestId}`;
    if ((!request.response && !request.current && !request.canceled) || seen.has(id)) return [];
    seen.add(id);
    const approval = request.payload.type === "tool_approval_request";
    const call = approval
      ? calls.findLast((item) => request.tools.some((tool) => tool.callId === item.id))
      : calls.findLast((item) => toolBaseName(item.name) === "ask_user");
    const hint = request.payload.type === "tool_approval_request" ? request.payload.value.hint : "";
    const answer = hitlPayload(request.response);
    return [
      create(InteractionSchema, {
        id,
        taskId: task.id,
        agentId,
        requestId: request.requestId,
        kind: approval ? InteractionKind.APPROVAL : InteractionKind.QUESTION,
        tools: request.tools.map((tool) => ({
          id: tool.id,
          callId: tool.callId,
          name: tool.name,
          args: value(tool.args),
        })),
        questions:
          request.payload.type === "ask_user_request"
            ? request.payload.value.questions.map(({ question, choices, multiple }) => ({
                question,
                choices,
                multiple,
              }))
            : [],
        explanation: call?.intent || (/FunctionResponse|ToolConfirmation/.test(hint) ? "" : hint),
        state: request.canceled
          ? ActivityState.CANCELED
          : !request.response
            ? approval
              ? ActivityState.AWAITING_APPROVAL
              : ActivityState.AWAITING_INPUT
            : !approval || approved(request)
              ? ActivityState.SUCCEEDED
              : request.decisions.some((item) => item.state === ActivityState.FAILED)
                ? ActivityState.FAILED
                : ActivityState.REJECTED,
        approvals: request.decisions,
        requestedAt: stamp(
          timeline(request.message.metadata) ??
            call?.startedAt ??
            (request.current ? millis(task.status?.timestamp) : undefined),
        ),
        answeredAt: stamp(
          request.canceled
            ? millis(task.status?.timestamp)
            : request.response
              ? timeline(request.response.metadata)
              : undefined,
        ),
        answers:
          answer?.type === "ask_user_response"
            ? answer.value.answers.map((item) => ({ values: item.answer }))
            : [],
        rejectionReason:
          answer?.type === "tool_approval_response"
            ? (answer.value.approvals.find((item) => !item.approved && item.rejectionReason)
                ?.rejectionReason ?? "")
            : "",
      }),
    ];
  });
}

export interface Decision {
  messageId: string;
  payload: JsonValue;
}

export function latestDecision(task: Task): Decision | undefined {
  const message = task.history.findLast(isHitlResponse);
  return message
    ? { messageId: message.messageId, payload: object(message.metadata?.[hitlExtension]) }
    : undefined;
}
