import { create, fromJson, type JsonValue, toJson } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import { describe, expect, it } from "vitest";
import { type Part, PartSchema, TaskSchema, TaskState } from "../gen/a2a_pb.js";
import { ActivityState } from "../gen/agentos/execution/v1/state_pb.js";
import { callEntries, toolCalls } from "../server/read-model/calls.js";
import { partTypeKey } from "../server/read-model/decode/messages.js";

function activity(kind: string, payload: JsonValue): Part {
  return create(PartSchema, {
    metadata: { [partTypeKey]: kind },
    content: { case: "data", value: fromJson(ValueSchema, payload) },
  });
}

function task(name: string, args: JsonValue, response: JsonValue) {
  return create(TaskSchema, {
    id: "task",
    contextId: "session",
    status: { state: TaskState.COMPLETED },
    artifacts: [
      { artifactId: "call", parts: [activity("function_call", { id: "call", name, args })] },
      {
        artifactId: "result",
        parts: [activity("function_response", { id: "call", name, response })],
      },
    ],
  });
}

describe("native Harness tool activity", () => {
  it("projects Codex MCP arguments and structured delegation results into the shared task graph", () => {
    const current = task(
      "kagent-collaboration.invoke_session",
      { arguments: { session_id: "child-session", message_id: "child-message" } },
      {
        result: {
          result: {
            structuredContent: {
              session_id: "child-session",
              task_id: "child-task",
              state: "TASK_STATE_COMPLETED",
            },
            content: [{ type: "text", text: "Child completed" }],
          },
          error: null,
        },
      },
    );
    const [entry] = callEntries(current, new Map());
    expect(entry).toMatchObject({
      id: "call",
      state: ActivityState.SUCCEEDED,
      delegation: {
        kind: "invoke",
        sessionId: "child-session",
        messageId: "child-message",
        taskId: "child-task",
      },
    });
    const [call] = toolCalls(current, "agentos/inspection", new Map());
    expect(call?.args && toJson(ValueSchema, call.args)).toEqual({
      session_id: "child-session",
      message_id: "child-message",
    });
  });

  it("resolves Claude MCP text results and preserves background delegation order", () => {
    const current = task(
      "mcp__team-sessions__dispatch_session",
      { session_id: "child-session", message_id: "child-message", message: "Work" },
      { result: [{ type: "text", text: JSON.stringify({ task: { id: "child-task" } }) }] },
    );
    expect(callEntries(current, new Map())[0]?.delegation).toMatchObject({
      kind: "background",
      sessionId: "child-session",
      messageId: "child-message",
      taskId: "child-task",
    });
  });

  it("marks native runtime and MCP failures as failed calls", () => {
    const responses: JsonValue[] = [
      { isError: true, result: [{ type: "text", text: "Query failed" }] },
      { result: { result: { isError: true, content: [{ type: "text", text: "Query failed" }] } } },
    ];
    for (const response of responses) {
      const current = task("tools.query", { arguments: {} }, response);
      const [call] = toolCalls(current, "agentos/inspection", new Map());
      expect(call?.state).toBe(ActivityState.FAILED);
      expect(call?.output && toJson(ValueSchema, call.output)).toBe("Query failed");
    }
  });
});
