import { fromJson, type JsonValue, toJson } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import { type Part, SendMessageResponseSchema } from "../../../gen/a2a_pb.js";
import {
  type InvokeSessionOutput,
  InvokeSessionOutputSchema,
} from "../../../gen/kagent/api/v1/collaboration_pb.js";
import {
  ToolActivitySchema,
  type ToolResponse,
} from "../../../gen/kagent/api/v1/interactions_pb.js";
import { object, partTypeKey, text } from "./messages.js";

const lenient = { ignoreUnknownFields: true };

export interface ToolEvent {
  kind: "function_call" | "function_response";
  id: string;
  name: string;
  args?: JsonValue;
  response?: ToolResponse;
}

export const toolEventId = (event: ToolEvent, source: string, position: number) =>
  event.id || `unpaired:${source}:${position}:${event.kind}`;

export function toolEvent(part: Part): ToolEvent | undefined {
  const kind = text(part.metadata?.[partTypeKey]);
  if ((kind !== "function_call" && kind !== "function_response") || part.content.case !== "data")
    return undefined;
  try {
    const activity = fromJson(
      ToolActivitySchema,
      object(toJson(ValueSchema, part.content.value)),
      lenient,
    );
    if (kind === "function_response" && !activity.response?.outcome.case) return undefined;
    return {
      kind,
      id: activity.id,
      name: activity.name,
      args: activity.args && toJson(ValueSchema, activity.args),
      response: activity.response,
    };
  } catch {
    return undefined;
  }
}

export interface Outcome {
  kind: "output" | "error" | "pending";
  value: JsonValue;
}

export function toolOutcome(response: ToolResponse | undefined): Outcome | undefined {
  const outcome = response?.outcome;
  if (!outcome?.case) return undefined;
  return { kind: outcome.case, value: toJson(ValueSchema, outcome.value) };
}

/** Tool text results may carry JSON documents; structured values are kept as is. */
export function structured(value: JsonValue | undefined): JsonValue | undefined {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as JsonValue;
  } catch {
    return value;
  }
}

export interface DelegationRef {
  /** Synchronous invocation, background dispatch or a native agent transfer. */
  kind: "invoke" | "background" | "handoff";
  sessionId: string;
  agentName: string;
  messageId: string;
  taskId: string;
  message?: string;
  invocation?: InvokeSessionOutput;
}

function invocation(output: JsonValue | undefined) {
  const value = structured(output);
  if (value === undefined || value === null) return undefined;
  try {
    return fromJson(InvokeSessionOutputSchema, object(value), lenient);
  } catch {
    return undefined;
  }
}

/** Accepted background results carry the native Task's context and input identity. */
function dispatched(args: JsonValue | undefined, output: JsonValue | undefined) {
  let contextId = text(object(args).session_id),
    messageId = text(object(args).message_id),
    taskId = "";
  try {
    const response = fromJson(SendMessageResponseSchema, object(structured(output)), lenient);
    if (response.payload.case === "task") {
      const task = response.payload.value;
      taskId = task.id;
      contextId = task.contextId || contextId;
      messageId ||= task.history.at(0)?.messageId ?? "";
    }
  } catch {}
  return { contextId, messageId, taskId };
}

export function delegationRef(
  event: Pick<ToolEvent, "name" | "args">,
  output?: JsonValue,
): DelegationRef | undefined {
  const args = object(event.args);
  switch (event.name) {
    case "invoke_session": {
      const result = invocation(output);
      return {
        kind: "invoke",
        sessionId: text(args.session_id),
        agentName: "",
        messageId: text(args.message_id),
        taskId: result?.taskId ?? "",
        message: text(args.message).trim(),
        invocation: result,
      };
    }
    case "dispatch_session": {
      const { contextId, messageId, taskId } = dispatched(event.args, output);
      return {
        kind: "background",
        sessionId: contextId,
        agentName: "",
        messageId,
        taskId,
      };
    }
    case "transfer_to_agent":
      return {
        kind: "handoff",
        sessionId: "",
        agentName: text(args.agent_name),
        messageId: "",
        taskId: "",
      };
    default: {
      const result = invocation(output);
      if (!result?.sessionId && !result?.taskId) return undefined;
      return {
        kind: "invoke",
        sessionId: result.sessionId,
        agentName: "",
        messageId: text(args.messageId) || text(args.message_id),
        taskId: result.taskId,
        invocation: result,
      };
    }
  }
}
