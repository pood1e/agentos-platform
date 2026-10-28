import { fromJson, type JsonValue, toJson } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import { type Part, SendMessageResponseSchema } from "../../../gen/a2a_pb.js";
import {
  type InvokeSessionOutput,
  InvokeSessionOutputSchema,
} from "../../../gen/kagent/api/v1/collaboration_pb.js";
import { ToolActivitySchema } from "../../../gen/kagent/api/v1/interactions_pb.js";
import { object, partTypeKey, text } from "./messages.js";

const lenient = { ignoreUnknownFields: true };

export interface ToolEvent {
  kind: "function_call" | "function_response";
  id: string;
  name: string;
  args?: JsonValue;
  response?: JsonValue;
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
export { toolBaseName } from "../../../shared/tool-name.js";

import { toolBaseName } from "../../../shared/tool-name.js";

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
  switch (toolBaseName(event.name)) {
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
