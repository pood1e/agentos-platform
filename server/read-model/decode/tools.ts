import { fromJson, type JsonValue, toJson } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import type { Part } from "../../../gen/a2a_pb.js";
import {
  type InvokeSessionInput,
  InvokeSessionInputSchema,
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

export type DelegationRef = Pick<InvokeSessionOutput, "sessionId" | "taskId"> &
  Pick<InvokeSessionInput, "messageId">;

/** Display anchors for native collaboration; TaskExecution establishes ancestry. */
export function delegationRef(
  event: Pick<ToolEvent, "name" | "args">,
  output?: JsonValue,
): DelegationRef | undefined {
  if (event.name !== "invoke_session") return undefined;
  try {
    const input = fromJson(InvokeSessionInputSchema, object(event.args), lenient);
    const result = fromJson(InvokeSessionOutputSchema, object(output), lenient);
    return {
      sessionId: result.sessionId || input.sessionId || "",
      messageId: input.messageId,
      taskId: result.taskId,
    };
  } catch {
    return undefined;
  }
}
