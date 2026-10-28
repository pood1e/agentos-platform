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

describe("canonical native tool activity", () => {
  it("projects native delegation identities without harness-specific decoding", () => {
    const current = task(
      "invoke_session",
      { session_id: "child-session", message_id: "child-message" },
      {
        output: {
          session_id: "child-session",
          task_id: "child-task",
          state: "TASK_STATE_COMPLETED",
        },
      },
    );
    expect(callEntries(current, new Map())[0]).toMatchObject({
      id: "call",
      state: ActivityState.SUCCEEDED,
      delegation: {
        kind: "invoke",
        sessionId: "child-session",
        messageId: "child-message",
        taskId: "child-task",
      },
    });
  });

  it("reads background delegation from a native A2A response", () => {
    const current = task(
      "dispatch_session",
      { session_id: "child-session", message_id: "child-message", message: "Work" },
      { output: { task: { id: "child-task" } } },
    );
    expect(callEntries(current, new Map())[0]?.delegation).toMatchObject({
      kind: "background",
      sessionId: "child-session",
      messageId: "child-message",
      taskId: "child-task",
    });
  });

  it.each<JsonValue>([false, null, 0, "", { arguments: 1, result: 2, output: 3 }])(
    "preserves application arguments and output %j",
    (output) => {
      const args = { arguments: { value: 1 } };
      const [call] = toolCalls(
        task("query.with.dots", args, { output }),
        "agentos/inspection",
        new Map(),
      );
      expect(call?.state).toBe(ActivityState.SUCCEEDED);
      expect(call?.args && toJson(ValueSchema, call.args)).toEqual(args);
      expect(call?.output && toJson(ValueSchema, call.output)).toEqual(output);
    },
  );

  it.each<["error" | "pending", JsonValue, ActivityState]>([
    ["error", "Query failed", ActivityState.FAILED],
    ["pending", { questions: ["Which namespace?"] }, ActivityState.AWAITING_INPUT],
  ])("projects the native %s outcome", (kind, value, state) => {
    const [call] = toolCalls(task("query", {}, { [kind]: value }), "agentos/inspection", new Map());
    expect(call?.state).toBe(state);
    expect(call?.output && toJson(ValueSchema, call.output)).toEqual(value);
  });

  it("keeps a call unobserved when the result has no native outcome", () => {
    expect(callEntries(task("query", {}, {}), new Map())[0]?.state).toBe(ActivityState.UNOBSERVED);
  });
});
