import { clone, create, toJsonString } from "@bufbuild/protobuf";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationSchema } from "../gen/agentos/console/v1/conversation_pb.js";
import { InteractionKind, InteractionSchema } from "../gen/agentos/console/v1/task_pb.js";
import { ActivityState } from "../gen/agentos/execution/v1/state_pb.js";
import {
  ApprovalSchema,
  Governance,
  GovernanceConfigSchema,
} from "../gen/agentos/governance/v1/governance_pb.js";
import { approvalReferences } from "../server/console/approval-references.js";
import { approvals } from "../server/governance/views.js";

vi.mock("../server/governance/views.js", () => ({ approvals: vi.fn() }));
const read = vi.mocked(approvals);
const task = () =>
  create(ConversationSchema, {
    interactions: [
      create(InteractionSchema, {
        id: "approval",
        taskId: "task",
        requestId: "request",
        kind: InteractionKind.APPROVAL,
        tools: [{ id: "tool", name: "business-service-action_update" }],
      }),
    ],
  });
const change = () =>
  create(ApprovalSchema, {
    id: "change",
    link: { name: "Review #19", url: "https://review.example/19" },
    state: ActivityState.AWAITING_APPROVAL,
  });
const resolver = () =>
  approvalReferences(
    { entry: async () => undefined },
    create(GovernanceConfigSchema, {
      environments: [
        {
          environment: { name: "business-service", governance: Governance.APPROVAL },
          approvalUrl: "https://decisions.example",
        },
      ],
    }),
  );
beforeEach(() => {
  read.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe("console ticket references", () => {
  it("shares native lookups and excludes request credentials and evidence from the task stream", async () => {
    read.mockResolvedValue({ approvals: [change()] });
    const enrich = resolver();
    const original = task();
    const [first, second] = await Promise.all([
      enrich(clone(ConversationSchema, original)),
      enrich(clone(ConversationSchema, original)),
    ]);
    expect(read).toHaveBeenCalledTimes(1);
    expect(first.interactions[0]?.approvals[0]).toMatchObject({
      link: { name: "Review #19" },
      state: ActivityState.AWAITING_APPROVAL,
    });
    expect(second).toEqual(first);
    expect(toJsonString(ConversationSchema, first)).not.toMatch(
      /private-credential|private evidence/,
    );
    expect(original.interactions[0]?.approvals).toEqual([]);
  });

  it("keeps the original collaboration available when an environment lookup fails", async () => {
    read.mockRejectedValue(new Error("environment unavailable"));
    const original = task();
    expect(await resolver()(clone(ConversationSchema, original))).toMatchObject({
      interactions: [{ external: true, approvals: [] }],
    });
  });

  it("preserves discovered ticket identity during a temporary environment outage", async () => {
    let clock = performance.now();
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    read
      .mockResolvedValueOnce({ approvals: [change()] })
      .mockRejectedValue(new Error("temporary outage"));
    const enrich = resolver();
    const original = task();
    const first = await enrich(clone(ConversationSchema, original));
    clock += 6_000;
    await new Promise((resolve) => setTimeout(resolve, 2));
    const observed = await enrich(clone(ConversationSchema, original));
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    expect(observed).toEqual(first);
  });
});
