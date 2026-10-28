import { create, fromJson } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import { expect, it } from "vitest";
import { MessageSchema, Role, TaskSchema, TaskState } from "../gen/a2a_pb.js";
import { ActivityState } from "../gen/agentos/execution/v1/state_pb.js";
import { ApprovalSchema } from "../gen/agentos/governance/v1/governance_pb.js";
import { ToolApprovalResponseSchema } from "../gen/kagent/api/v1/interactions_pb.js";
import {
  approvalDecisions,
  withApprovalDecisions,
} from "../server/read-model/decode/approval-decisions.js";
import { hitlExtension, hitlReply } from "../server/read-model/decode/hitl.js";
import { partTypeKey } from "../server/read-model/decode/messages.js";
import { ingest } from "../server/read-model/entry.js";

function task(state: ActivityState, taskId = "task", approved = false) {
  const request = create(MessageSchema, {
    messageId: "request",
    role: Role.AGENT,
    parts: [
      { content: { case: "text", value: "Please provide FunctionResponse and ToolConfirmation" } },
    ],
    extensions: [hitlExtension],
    metadata: {
      [hitlExtension]: {
        type: "tool_approval_request",
        tools: [{ id: "tool", call_id: "call", name: "environment-service_write" }],
      },
    },
  });
  const response = withApprovalDecisions(
    hitlReply(
      { taskId: "task", contextId: "context" },
      "response",
      {
        type: "tool_approval_response",
        value: create(ToolApprovalResponseSchema, {
          approvals: [{ id: "tool", approved, rejectionReason: "Required evidence is missing" }],
        }),
      },
      "Decision verified",
    ),
    [
      create(ApprovalSchema, {
        id: "decision",
        state,
        reason: "Required evidence is missing",
        decidedBy: state === ActivityState.REJECTED ? "Reviewer" : "",
        reference: { taskId, toolId: "tool" },
      }),
    ],
  );
  return create(TaskSchema, {
    id: "task",
    contextId: "context",
    status: { state: TaskState.WORKING },
    history: [request, response],
    artifacts: [
      {
        artifactId: "call",
        parts: [
          {
            metadata: { [partTypeKey]: "function_call" },
            content: {
              case: "data",
              value: fromJson(ValueSchema, {
                id: "call",
                name: "environment-service_write",
                args: {},
              }),
            },
          },
        ],
      },
    ],
  });
}

it.each([ActivityState.FAILED, ActivityState.REJECTED])(
  "preserves decision state %s instead of converting every negative reply into a human rejection",
  (state) => {
    const record = task(state);
    const entry = ingest(record, "workspace/agent");
    expect(entry.interactions[0]).toMatchObject({
      state,
      rejectionReason: "Required evidence is missing",
      approvals: [{ state, decidedBy: state === ActivityState.REJECTED ? "Reviewer" : "" }],
    });
    expect(entry.calls[0]?.state).toBe(state);
    expect(entry.calls[0]?.intent).not.toContain("FunctionResponse");
    expect(ingest(create(TaskSchema, record), "workspace/agent").interactions).toEqual(
      entry.interactions,
    );
  },
);

it("does not use a foreign decision record or a positive snapshot to approve a negative native reply", () => {
  const foreign = task(ActivityState.FAILED, "another-task");
  expect(approvalDecisions(foreign.history[1])).toEqual([]);
  expect(ingest(foreign, "workspace/agent").interactions[0]?.state).toBe(ActivityState.REJECTED);
  expect(ingest(task(ActivityState.SUCCEEDED), "workspace/agent").interactions[0]?.state).toBe(
    ActivityState.REJECTED,
  );
});
