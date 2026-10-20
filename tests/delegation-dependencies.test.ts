import { fromJson, type JsonValue } from "@bufbuild/protobuf";
import { expect, it } from "vitest";
import { TaskSchema } from "../gen/a2a_pb.js";
import { callEntries } from "../server/read-model/calls.js";
import { partTypeKey } from "../server/read-model/decode/messages.js";
import { ingest } from "../server/read-model/entry.js";
import { taskDetail } from "../server/read-model/views/task.js";
import { fixtureIndex } from "./fixtures/kagent.js";

function recorded(events: [string, "call" | "reply", string?][]) {
  return fromJson(TaskSchema, {
    id: "operation",
    contextId: "coordinator-context",
    status: { state: "TASK_STATE_COMPLETED" },
    artifacts: events.map(([id, kind, name = "invoke_session"], index) => ({
      artifactId: `event-${index}`,
      parts: [
        {
          data: {
            id,
            name,
            ...(kind === "call"
              ? { args: { session_id: "worker-session" } }
              : { response: { output: {} } }),
          },
          metadata: { [partTypeKey]: `function_${kind === "call" ? "call" : "response"}` },
        },
      ],
    })),
  } as JsonValue);
}

it("extracts partial joins from observed replies without requiring a clock", () => {
  const task = recorded([
    ["a", "call"],
    ["b", "call"],
    ["a", "reply"],
    ["c", "call"],
    ["b", "reply"],
    ["c", "reply"],
    ["d", "call"],
  ]);
  expect(
    callEntries(task, new Map()).map(({ id, dependsOn, returned }) => ({
      id,
      dependsOn,
      returned,
    })),
  ).toEqual([
    { id: "a", dependsOn: [], returned: true },
    { id: "b", dependsOn: [], returned: true },
    { id: "c", dependsOn: ["a"], returned: true },
    { id: "d", dependsOn: ["b", "c"], returned: false },
  ]);
  const index = fixtureIndex([]);
  index.setSession({
    id: "worker-session",
    agentId: "agentos/inspection",
    name: "Independent worker",
  });
  index.upsert(ingest(task, "agentos/coordinator"));
  expect(taskDetail(index, task.id)?.delegations.find((link) => link.callId === "d")).toMatchObject(
    { dependsOn: ["call:operation:b", "call:operation:c"], returned: false },
  );
});

it("does not make a background completion a prerequisite for later work", () => {
  const task = recorded([
    ["a", "call"],
    ["a", "reply"],
    ["knowledge", "call", "dispatch_session"],
    ["knowledge", "reply", "dispatch_session"],
    ["b", "call"],
  ]);
  expect(callEntries(task, new Map()).map(({ dependsOn }) => dependsOn)).toEqual([
    [],
    ["a"],
    ["a"],
  ]);
});

it("does not treat re-delivered replies as a new dependency", () => {
  const task = recorded([
    ["a", "call"],
    ["a", "reply"],
    ["b", "call"],
    ["b", "reply"],
    ["a", "reply"],
    ["c", "call"],
  ]);
  expect(callEntries(task, new Map()).at(-1)?.dependsOn).toEqual(["b"]);
});
