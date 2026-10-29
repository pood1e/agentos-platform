import { create, fromJson, type JsonValue, toJson } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import { describe, expect, it } from "vitest";
import { type Part, PartSchema, TaskSchema, TaskState } from "../gen/a2a_pb.js";
import { ActivityState } from "../gen/agentos/execution/v1/state_pb.js";
import { callEntries, toolCalls } from "../server/read-model/calls.js";
import { partTypeKey } from "../server/read-model/decode/messages.js";
import { ingest } from "../server/read-model/entry.js";
import { TaskGraph } from "../server/read-model/graph.js";
import { busy, taskTree } from "../server/read-model/tree.js";

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
        sessionId: "child-session",
        messageId: "child-message",
        taskId: "child-task",
      },
    });
  });

  it("reads background delegation from the native invocation contract", () => {
    const current = task(
      "invoke_session",
      {
        session_id: "child-session",
        message_id: "child-message",
        message: "Work",
        background: true,
      },
      { output: { session_id: "child-session", task_id: "child-task" } },
    );
    expect(callEntries(current, new Map())[0]?.delegation).toMatchObject({
      sessionId: "child-session",
      messageId: "child-message",
      taskId: "child-task",
    });
  });

  it.each<JsonValue>([
    false,
    null,
    0,
    "",
    "false",
    "null",
    "0",
    '{"task_id":"application-result"}',
    { arguments: 1, result: 2, output: 3 },
  ])("preserves application arguments and output %j", (output) => {
    const args = { arguments: { value: 1 } };
    const [call] = toolCalls(
      task("query.with.dots", args, { output }),
      "agentos/inspection",
      new Map(),
    );
    expect(call?.state).toBe(ActivityState.SUCCEEDED);
    expect(call?.args && toJson(ValueSchema, call.args)).toEqual(args);
    expect(call?.output && toJson(ValueSchema, call.output)).toEqual(output);
  });

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

  it("keeps a native tool failure after approval", () => {
    const current = task("query", {}, { error: "upstream unavailable" });
    expect(callEntries(current, new Map([["call", "approved"]]))[0]?.state).toBe(
      ActivityState.FAILED,
    );
  });

  it("keeps completed tasks available despite an untrusted invocation result", () => {
    const current = task(
      "invoke_session",
      { session_id: "other-session", message_id: "other-message" },
      { output: { task_id: "other-task", state: "TASK_STATE_INPUT_REQUIRED" } },
    );
    const entry = ingest(current, "agentos/assistant");
    const graph = new TaskGraph([entry]);
    const tree = taskTree(graph, current.id);
    expect(tree && busy(tree)).toBe(false);
    expect(graph.relations().parents.size).toBe(0);
    expect(entry.calls[0]?.state).toBe(ActivityState.SUCCEEDED);
  });

  it("keeps application results separate from native collaboration", () => {
    const current = task(
      "query",
      {},
      { output: { session_id: "child-session", task_id: "child-task" } },
    );
    expect(callEntries(current, new Map())[0]?.delegation).toBeUndefined();
  });
});
