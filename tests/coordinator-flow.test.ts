import { fromJson } from "@bufbuild/protobuf";
import { expect, it } from "vitest";
import { TaskSchema, TaskState } from "../gen/a2a_pb.js";
import { ActivityState } from "../gen/agentos/console/v1/state_pb.js";
import { partTypeKey } from "../server/read-model/decode/messages.js";
import { ingest } from "../server/read-model/entry.js";
import { taskDetail } from "../server/read-model/views/task.js";
import { fixtureIndex } from "./fixtures/kagent.js";

const parent = (returned = false) =>
  fromJson(TaskSchema, {
    id: "chat-task",
    contextId: "chat-context",
    status: { state: returned ? "TASK_STATE_COMPLETED" : "TASK_STATE_WORKING" },
    history: [
      { messageId: "chat-input", role: "ROLE_USER", parts: [{ text: "验证方案" }] },
      {
        messageId: "chat-call",
        role: "ROLE_AGENT",
        parts: [
          {
            data: {
              name: "delegate_coordinator",
              id: "delegate-1",
              args: {
                messageId: "coordinator-input",
                role: "ROLE_USER",
                parts: [{ text: "验证方案" }],
              },
            },
            metadata: { [partTypeKey]: "function_call" },
          },
        ],
      },
    ],
    artifacts: returned
      ? [
          {
            artifactId: "reply",
            parts: [
              {
                data: {
                  name: "delegate_coordinator",
                  id: "delegate-1",
                  response: {
                    output: {
                      session_id: "coordinator-context",
                      task_id: "coordinator-task",
                      state: "TASK_STATE_INPUT_REQUIRED",
                      text: "等待审批",
                    },
                  },
                },
                metadata: { [partTypeKey]: "function_response" },
              },
            ],
          },
        ]
      : [],
  });

const child = () =>
  fromJson(TaskSchema, {
    id: "coordinator-task",
    contextId: "coordinator-context",
    status: { state: "TASK_STATE_WORKING" },
    history: [{ messageId: "coordinator-input", role: "ROLE_USER", parts: [{ text: "验证方案" }] }],
  });

it("shows the coordinator and associates its task before the delegation returns", () => {
  const index = fixtureIndex([]);
  const calling = ingest(parent(), "agentos/assistant");
  index.upsert(calling);
  expect(taskDetail(index, calling.id)?.delegations[0]).toMatchObject({
    sourceAgentId: "agentos/assistant",
    targetAgentId: "agentos/coordinator",
    state: ActivityState.WORKING,
  });
  index.upsert(ingest(child(), "agentos/coordinator"));
  expect(index.target(calling, calling.calls[0])).toBe("coordinator-task");
});

it("does not associate another engineer with a coordinator-only delegation", () => {
  const index = fixtureIndex([]);
  const calling = ingest(parent(), "agentos/assistant");
  index.upsert(calling);
  index.upsert(ingest(child(), "agentos/remediation"));
  expect(index.target(calling, calling.calls[0])).toBeUndefined();
});

it("retains native pending input for the existing approval continuation", () => {
  const calling = ingest(parent(true), "agentos/assistant");
  expect(calling.calls[0]).toMatchObject({
    state: ActivityState.AWAITING_INPUT,
    delegation: {
      sessionId: "coordinator-context",
      taskId: "coordinator-task",
      invocation: { state: TaskState.INPUT_REQUIRED },
    },
  });
});
