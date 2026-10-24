import { toJson } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import type { CallToolResult } from "@modelcontextprotocol/client";
import { ActivityState } from "../../../../gen/agentos/execution/v1/state_pb.js";
import type { ToolCall } from "../../../../gen/agentos/execution/v1/task_pb.js";

export function appResult(call: ToolCall): CallToolResult {
  const output = call.output ? toJson(ValueSchema, call.output) : null;
  return {
    content: [{ type: "text", text: typeof output === "string" ? output : JSON.stringify(output) }],
    ...(output && typeof output === "object" && !Array.isArray(output)
      ? { structuredContent: output }
      : {}),
    isError: call.state === ActivityState.FAILED || call.state === ActivityState.REJECTED,
  };
}
