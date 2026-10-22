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
  content: message.parts.flatMap(
    (part): Exclude<ThreadMessageLike["content"], string>[number][] => {
      const content = part.content;
      if (content.case === "text" || content.case === "progress")
        return [
          {
            id: part.id,
            type: content.case === "text" ? "text" : "reasoning",
            text: content.value,
          },
        ];
      if (content.case !== "toolCall") return [];
      const call = content.value;
      return [
        {
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
        },
      ];
    },
  ),
});
