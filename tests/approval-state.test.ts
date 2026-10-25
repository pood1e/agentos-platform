import { create } from "@bufbuild/protobuf";
import { expect, it } from "vitest";
import { InteractionSchema } from "../gen/agentos/console/v1/task_pb.js";
import { ActivityState } from "../gen/agentos/execution/v1/state_pb.js";
import { ApprovalSchema } from "../gen/agentos/governance/v1/governance_pb.js";
import { approvalInteractionState } from "../shared/approval-state.js";

it("displays the verified human decision while native resumption is still pending", () => {
  const interaction = create(InteractionSchema, {
    taskId: "task",
    external: true,
    state: ActivityState.AWAITING_APPROVAL,
    tools: [{ id: "write" }],
  });
  const record = create(ApprovalSchema, {
    state: ActivityState.SUCCEEDED,
    reference: { taskId: "task", toolId: "write" },
  });
  expect(approvalInteractionState(interaction, [record])).toBe(ActivityState.SUCCEEDED);
  expect(approvalInteractionState(interaction, [{ ...record, state: ActivityState.WORKING }])).toBe(
    ActivityState.SUCCEEDED,
  );
  expect(interaction.state).toBe(ActivityState.AWAITING_APPROVAL);
  expect(approvalInteractionState(interaction, [])).toBe(ActivityState.AWAITING_APPROVAL);
  expect(
    approvalInteractionState(
      create(InteractionSchema, { ...interaction, tools: [{ id: "write" }, { id: "second" }] }),
      [record],
    ),
  ).toBe(ActivityState.AWAITING_APPROVAL);
  expect(
    approvalInteractionState(interaction, [
      create(ApprovalSchema, { ...record, reference: { toolId: "write", taskId: "other" } }),
    ]),
  ).toBe(ActivityState.AWAITING_APPROVAL);
  expect(approvalInteractionState({ ...interaction, state: ActivityState.FAILED }, [record])).toBe(
    ActivityState.FAILED,
  );
});
