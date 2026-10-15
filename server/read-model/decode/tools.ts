import { fromJson, type JsonValue, toJson } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import { type Part, SendMessageResponseSchema } from "../../../gen/a2a_pb.js";
import { DelegationKind } from "../../../gen/agentos/console/v1/task_pb.js";
import {
  type InvokeSessionOutput,
  InvokeSessionOutputSchema,
  ToolActivitySchema,
} from "../../../gen/agentos/kagent/v1/wire_pb.js";
import { object, partTypeKey, text } from "./messages.js";

const lenient = { ignoreUnknownFields: true };

export interface ToolEvent {
  kind: "function_call" | "function_response";
  id: string;
  name: string;
  args?: JsonValue;
  response?: JsonValue;
}

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
    let args = activity.args && toJson(ValueSchema, activity.args);
    let response = activity.response && toJson(ValueSchema, activity.response);
    // The pinned Codex adapter wraps MCP input and output one level below the common envelope.
    if (activity.name.includes(".")) {
      if ("arguments" in object(args)) args = object(args).arguments;
      const result = object(object(response).result);
      if ("result" in result) response = { ...object(response), result: result.result ?? null };
    }
    return {
      kind,
      id: activity.id,
      name: activity.name,
      args,
      response,
    };
  } catch {
    return undefined;
  }
}

/** Native adapters use server__tool, mcp__server__tool or server.tool. */
export const toolBaseName = (name: string) => name.split(/__|\./).at(-1) ?? name;

export type Outcome =
  | { kind: "output"; value: JsonValue | undefined }
  | { kind: "error"; value: string }
  | { kind: "pending"; value: JsonValue | undefined };

/**
 * adk-go MCP tools respond with `{output}` or `{error}`; kagent function tools
 * return their own maps, and ask_user returns `{status: "pending"}` before the answer.
 */
export function toolOutcome(response: JsonValue | undefined): Outcome {
  const envelope = object(response);
  if (typeof envelope.error === "string") return { kind: "error", value: envelope.error };
  if (envelope.status === "pending") return { kind: "pending", value: response };
  const result =
    "output" in envelope ? envelope.output : "result" in envelope ? envelope.result : response;
  const value = mcpOutput(result);
  if (envelope.isError === true || object(result).isError === true)
    return {
      kind: "error",
      value: typeof value === "string" ? value : (JSON.stringify(value) ?? ""),
    };
  return { kind: "output", value };
}

function mcpOutput(value: JsonValue | undefined): JsonValue | undefined {
  const result = object(value);
  if (result.structuredContent != null) return result.structuredContent;
  const content = Array.isArray(value) ? value : result.content;
  if (
    Array.isArray(content) &&
    content.length &&
    content.every((item) => object(item).type === "text")
  )
    return content.map((item) => text(object(item).text)).join("\n");
  return value;
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
  kind: DelegationKind;
  sessionId: string;
  agentName: string;
  messageId: string;
  taskId: string;
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

/** dispatch_session takes an A2A Message, whose JSON accepts both field name spellings. */
function dispatched(args: JsonValue | undefined, output: JsonValue | undefined) {
  const message = object(args);
  let taskId = "";
  try {
    const response = fromJson(SendMessageResponseSchema, object(structured(output)), lenient);
    if (response.payload.case === "task") taskId = response.payload.value.id;
  } catch {}
  return {
    contextId: text(message.contextId) || text(message.context_id),
    messageId: text(message.messageId) || text(message.message_id),
    taskId,
  };
}

export function delegationRef(
  event: Pick<ToolEvent, "name" | "args">,
  output?: JsonValue,
): DelegationRef | undefined {
  const args = object(event.args);
  switch (toolBaseName(event.name)) {
    case "delegate_coordinator": {
      const result = invocation(output);
      return {
        kind: DelegationKind.INVOKE,
        sessionId: result?.sessionId ?? "",
        agentName: "coordinator",
        messageId: text(args.messageId) || text(args.message_id),
        taskId: result?.taskId ?? "",
        invocation: result,
      };
    }
    case "invoke_session": {
      const result = invocation(output);
      return {
        kind: DelegationKind.INVOKE,
        sessionId: text(args.session_id),
        agentName: "",
        messageId: text(args.message_id),
        taskId: result?.taskId ?? "",
        invocation: result,
      };
    }
    case "dispatch_session": {
      const { contextId, messageId, taskId } = dispatched(event.args, output);
      return {
        kind: DelegationKind.BACKGROUND,
        sessionId: contextId,
        agentName: "",
        messageId,
        taskId,
      };
    }
    case "transfer_to_agent":
      return {
        kind: DelegationKind.HANDOFF,
        sessionId: "",
        agentName: text(args.agent_name),
        messageId: "",
        taskId: "",
      };
    default:
      return undefined;
  }
}
