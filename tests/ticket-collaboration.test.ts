import { create } from "@bufbuild/protobuf";
import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { describe, expect, it } from "vitest";
import { InteractionKind, InteractionSchema } from "../gen/agentos/console/v1/task_pb.js";
import { ActivityState } from "../gen/agentos/execution/v1/state_pb.js";
import { ApprovalSchema } from "../gen/agentos/governance/v1/governance_pb.js";
import { approvalNodeId } from "../src/features/tasks/flow/approval-activities.js";
import {
  collaborationFlow,
  instanceNodeId,
} from "../src/features/tasks/flow/collaboration-flow.js";
import { bundleConnections } from "../src/features/tasks/flow/connection-bundles.js";
import { collaborationDetail, link, root } from "./fixtures/collaboration.js";

const ticket = (environment = "aiops-real", id = "19") =>
  create(ApprovalSchema, {
    id: `change-${environment}-${id}`,
    link: { name: `Review #${id}`, url: `https://${environment}.example/review/${id}` },
  });
const approval = (id: string, taskId: string, time: number, state = ActivityState.SUCCEEDED) =>
  create(InteractionSchema, {
    id,
    taskId,
    agentId: taskId === root.taskId ? root.agentId : "asset",
    requestId: `request-${id}`,
    kind: InteractionKind.APPROVAL,
    state,
    requestedAt: timestampFromMs(time),
    approvals: [ticket()],
  });

describe("native work-order nodes", () => {
  it("shares one ticket across requests from multiple instances and preserves all decisions", () => {
    const first = approval("first", root.taskId, 1, ActivityState.REJECTED);
    const second = approval("second", "task-asset", 2);
    const pending = approval("third", "task-asset", 3, ActivityState.AWAITING_APPROVAL);
    const flow = collaborationFlow(
      collaborationDetail([link("asset")], { interactions: [pending, second, first] }),
    );
    const nodes = flow.activities.filter((item) => item.kind === "approval");
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({
      id: approvalNodeId(ticket()),
      state: ActivityState.AWAITING_APPROVAL,
      taskIds: [root.taskId, "task-asset"],
    });
    expect(nodes[0]?.interactions.map((item) => item.requestId)).toEqual([
      "request-first",
      "request-second",
      "request-third",
    ]);
    const history = flow.connections.filter((item) => item.step.link.kind === "approval");
    expect(history.filter((item) => item.phase === "approval")).toHaveLength(3);
    expect(history.filter((item) => item.phase === "return").map((item) => item.target)).toEqual([
      instanceNodeId(root.contextId),
      instanceNodeId("context-asset"),
    ]);
    expect(bundleConnections(history)).toHaveLength(2);
  });

  it("keeps equal ticket numbers in different environments separate", () => {
    const first = approval("first", root.taskId, 1);
    const second = approval("second", root.taskId, 2);
    second.approvals = [ticket("another-real")];
    const flow = collaborationFlow(collaborationDetail([], { interactions: [first, second] }));
    expect(
      flow.activities.filter((item) => item.kind === "approval").map((item) => item.id),
    ).toEqual([approvalNodeId(ticket()), approvalNodeId(ticket("another-real"))]);
  });

  it("deduplicates repeated change references without merging unrelated tickets or questions", () => {
    const first = approval("first", root.taskId, 1);
    first.approvals.push(ticket(), ticket("aiops-real", "20"));
    const question = approval("question", root.taskId, 2);
    question.kind = InteractionKind.QUESTION;
    const unknown = approval("unlinked", root.taskId, 3);
    unknown.approvals = [];
    const flow = collaborationFlow(
      collaborationDetail([], { interactions: [first, question, unknown] }),
    );
    expect(
      flow.activities.filter((item) => item.kind === "approval").map((item) => item.id),
    ).toEqual([
      approvalNodeId(ticket()),
      approvalNodeId(ticket("aiops-real", "20")),
      "interaction:question",
      "interaction:unlinked",
    ]);
    expect(
      flow.activities.find((item) => item.id === approvalNodeId(ticket()))?.interactions,
    ).toHaveLength(1);
  });
});
