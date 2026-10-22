import type { ThreadMessageLike } from "@assistant-ui/react";
import { toJson } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import { Role } from "../../../gen/a2a_pb.js";
import type { ChatMessage } from "../../../gen/agentos/console/v1/conversation_pb.js";
import { ActivityState } from "../../../gen/agentos/execution/v1/state_pb.js";
import { redact } from "../../../shared/redact.js";
import { pretty } from "../../lib/format.js";
import { active, awaiting } from "../status/activity.js";

export const convertMessage = (message: ChatMessage): ThreadMessageLike => ({
  id: message.id,
  role: message.role === Role.USER ? "user" : "assistant",
  content: [
    ...(message.progress ? [{ type: "reasoning" as const, text: message.progress }] : []),
    ...message.calls.map((call) => ({
      type: "tool-call" as const,
      toolCallId: call.id,
      toolName: call.name,
      argsText: pretty(call.args) ?? "",
      result: call.output
        ? redact(toJson(ValueSchema, call.output))
        : active(call.state) || awaiting(call.state)
          ? undefined
          : null,
      isError: call.state === ActivityState.FAILED || call.state === ActivityState.REJECTED,
      isPreliminary: active(call.state) || awaiting(call.state),
      artifact: call,
    })),
    ...(message.text ? [{ type: "text" as const, text: message.text }] : []),
  ],
});
