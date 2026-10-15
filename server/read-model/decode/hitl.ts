import { create, fromJson, type JsonValue, toJson } from "@bufbuild/protobuf";
import { type Message, MessageSchema, Role } from "../../../gen/a2a_pb.js";
import {
  type AskUserRequest,
  AskUserRequestSchema,
  type AskUserResponse,
  AskUserResponseSchema,
  type ToolApprovalRequest,
  ToolApprovalRequestSchema,
  type ToolApprovalResponse,
  ToolApprovalResponseSchema,
} from "../../../gen/agentos/kagent/v1/wire_pb.js";
import { object, timelineKey } from "./messages.js";

export const hitlExtension = "https://kagent.dev/extensions/hitl/v1";

export type HitlPayload =
  | { type: "tool_approval_request"; value: ToolApprovalRequest }
  | { type: "ask_user_request"; value: AskUserRequest }
  | { type: "tool_approval_response"; value: ToolApprovalResponse }
  | { type: "ask_user_response"; value: AskUserResponse };

const lenient = { ignoreUnknownFields: true };

export function hitlPayload(message?: Message): HitlPayload | undefined {
  if (!message?.extensions.includes(hitlExtension)) return undefined;
  const raw: JsonValue = object(message.metadata?.[hitlExtension]);
  switch (raw.type) {
    case "tool_approval_request":
      return { type: raw.type, value: fromJson(ToolApprovalRequestSchema, raw, lenient) };
    case "ask_user_request":
      return { type: raw.type, value: fromJson(AskUserRequestSchema, raw, lenient) };
    case "tool_approval_response":
      return { type: raw.type, value: fromJson(ToolApprovalResponseSchema, raw, lenient) };
    case "ask_user_response":
      return { type: raw.type, value: fromJson(AskUserResponseSchema, raw, lenient) };
    default:
      return undefined;
  }
}

export const isHitlResponse = (message: Message) => {
  const type = hitlPayload(message)?.type;
  return type === "tool_approval_response" || type === "ask_user_response";
};

/** Builds the native HITL reply that kagent parses with its Go structs. */
export function hitlReply(
  target: { taskId: string; contextId: string },
  messageId: string,
  payload:
    | { type: "tool_approval_response"; value: ToolApprovalResponse }
    | { type: "ask_user_response"; value: AskUserResponse },
  summary: string,
  now = new Date(),
): Message {
  const options = { useProtoFieldName: true, alwaysEmitImplicit: true };
  payload.value.type = payload.type;
  const json =
    payload.type === "tool_approval_response"
      ? toJson(ToolApprovalResponseSchema, payload.value, options)
      : toJson(AskUserResponseSchema, payload.value, options);
  return create(MessageSchema, {
    messageId,
    contextId: target.contextId,
    taskId: target.taskId,
    role: Role.USER,
    extensions: [hitlExtension],
    metadata: { [hitlExtension]: json, [timelineKey]: now.toISOString() },
    parts: [{ content: { case: "text", value: summary } }],
  });
}
