import assert from "node:assert/strict";
import { create } from "@bufbuild/protobuf";
import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { describe, expect, it } from "vitest";
import { Role, TaskSchema, TaskState } from "../gen/a2a_pb.js";
import { ActivityState } from "../gen/agentos/console/v1/state_pb.js";
import {
  DelegationKind,
  InteractionKind,
  InteractionSchema,
} from "../gen/agentos/console/v1/task_pb.js";
import { createdAtKey } from "../server/read-model/decode/messages.js";
import { ingest } from "../server/read-model/entry.js";
import { listTasks, taskDetail } from "../server/read-model/views/task.js";
import { changeId } from "../server/shared/change-digest.js";
import { collaborationFlow } from "../src/features/tasks/flow/collaboration-flow.js";
import { collaborationLayout } from "../src/features/tasks/flow/collaboration-layout.js";
import type { Link } from "../src/features/tasks/flow/links.js";
import { fixtureIndex, fixtureIds as ids } from "./fixtures/kagent.js";

const engineer = "agentos/remediation";
const reviewer = "agentos/reviewer";
const root = { taskId: "operation", agentId: engineer };
const interaction = (id: string, requested: number, answered?: number) =>
  create(InteractionSchema, {
    id,
    requestId: id,
    taskId: root.taskId,
    agentId: engineer,
    kind: InteractionKind.APPROVAL,
    state: answered === undefined ? ActivityState.AWAITING_APPROVAL : ActivityState.SUCCEEDED,
    requestedAt: timestampFromMs(requested),
    answeredAt: answered === undefined ? undefined : timestampFromMs(answered),
  });
const review = (id: string, requestId: string, start: number, end?: number): Link => ({
  id,
  kind: "review",
  source: engineer,
  target: reviewer,
  sourceTaskId: root.taskId,
  targetTaskId: `task-${id}`,
  requestId,
  startedAt: start,
  finishedAt: end,
  state: end === undefined ? ActivityState.WORKING : ActivityState.SUCCEEDED,
});

describe("native review projection", () => {
  it("attaches an independent review to its paused operation without adding a task-list item", () => {
    const index = fixtureIndex();
    const source = index.entry(ids.approved);
    const approval = source?.interactions.find((item) => item.kind === InteractionKind.APPROVAL);
    assert(source && approval?.tools[0]);
    const task = create(TaskSchema, {
      id: "independent-review",
      contextId: "isolated-review-session",
      metadata: { [createdAtKey]: new Date(2_000).toISOString() },
      status: { state: TaskState.COMPLETED, timestamp: timestampFromMs(4_000) },
      history: [
        {
          role: Role.USER,
          metadata: {
            "agentos.dev/review-task": source.id,
            "agentos.dev/change-id": changeId(source.id, approval.tools[0].id),
          },
        },
      ],
    });
    index.upsert(ingest(task, reviewer));
    const detail = taskDetail(index, ids.approvalRoot);
    expect(detail?.participants.map((item) => item.id)).toContain(reviewer);
    expect(detail?.runs.find((run) => run.taskId === task.id)).toMatchObject({ agentId: reviewer });
    expect(detail?.delegations.find((link) => link.targetTaskId === task.id)).toMatchObject({
      kind: DelegationKind.REVIEW,
      sourceTaskId: source.id,
      targetAgentId: reviewer,
      requestId: approval.requestId,
    });
    expect(index.relations().parents.get(task.id)).toBe(source.id);
    expect(listTasks(index, { query: task.id, pageSize: 20, pageToken: "" }).totalSize).toBe(0);
    task.history[0].metadata = {
      ...task.history[0].metadata,
      "agentos.dev/change-id": "unrelated",
    };
    index.upsert(ingest(task, reviewer));
    expect(
      taskDetail(index, ids.approvalRoot)?.delegations.some(
        (link) => link.targetTaskId === task.id,
      ),
    ).toBe(false);
  });
});

describe("approval collaboration", () => {
  const layout = (links: Link[], interactions: ReturnType<typeof interaction>[]) =>
    collaborationLayout(
      collaborationFlow({
        participants: [engineer, ...new Set(links.map((link) => link.target))],
        root,
        window: { start: 0 },
        links,
        interactions,
      }),
    );

  it("shows a running reviewer and resumes only after the work-order decision", () => {
    const pending = layout([review("review-a", "pause-a", 2_000)], [interaction("pause-a", 1_000)]);
    expect(pending.activities.map((node) => node.kind)).toEqual(["entry", "review"]);
    expect(pending.activities[1]).toMatchObject({ agentId: reviewer, taskId: "task-review-a" });
    expect(pending.activities[1]?.step?.link.state).toBe(ActivityState.WORKING);
    const finished = layout(
      [review("review-a", "pause-a", 2_000, 4_000)],
      [interaction("pause-a", 1_000, 5_000)],
    );
    expect(finished.activities.map((node) => [node.kind, node.column])).toEqual([
      ["entry", 1],
      ["review", 2],
      ["continued", 3],
    ]);
  });

  it("keeps repeated approvals in their actual request order", () => {
    const result = layout(
      [review("review-b", "pause-b", 7_000, 8_000), review("review-a", "pause-a", 2_000, 4_000)],
      [interaction("pause-b", 6_000, 9_000), interaction("pause-a", 1_000, 5_000)],
    );
    expect(result.activities.map((node) => [node.kind, node.column])).toEqual([
      ["entry", 1],
      ["review", 2],
      ["continued", 3],
      ["review", 4],
      ["continued", 5],
    ]);
    expect(result.connections.find((edge) => edge.id === "review-b:request")?.source).toBe(
      "pause-a:continued",
    );
    expect(result.activities.some((node) => node.kind === "approval")).toBe(false);
  });

  it("keeps parallel reviewers in one column and waits for every review", () => {
    const result = layout(
      [
        review("review-a", "pause", 2_000, 8_000),
        { ...review("review-b", "pause", 3_000, 7_000), target: "agentos/reviewer-2" },
      ],
      [interaction("pause", 1_000, 9_000)],
    );
    expect(
      result.activities.filter((node) => node.kind === "review").map((node) => node.column),
    ).toEqual([2, 2]);
    expect(result.connections.filter((edge) => edge.target === "pause:continued")).toHaveLength(2);
  });

  it("keeps coordinates stable when only the review state changes", () => {
    const before = layout([review("review-a", "pause", 2_000)], [interaction("pause", 1_000)]);
    const after = layout(
      [review("review-a", "pause", 2_000, 4_000)],
      [interaction("pause", 1_000)],
    );
    expect(after.key).toBe(before.key);
    expect(after.activities.map(({ id, x, y }) => [id, x, y])).toEqual(
      before.activities.map(({ id, x, y }) => [id, x, y]),
    );
  });

  it("preserves human approval when no engineer was assigned to review", () => {
    expect(
      layout([], [interaction("human-pause", 1_000)]).activities.map((node) => node.kind),
    ).toEqual(["entry", "approval"]);
  });

  it("returns to the coordinator after review and continued execution", () => {
    const coordinator = "agentos/coordinator";
    const result = collaborationLayout(
      collaborationFlow({
        participants: [coordinator, engineer, reviewer],
        root: { taskId: "supervision", agentId: coordinator },
        window: { start: 0 },
        links: [
          {
            id: "delegate",
            kind: "invoke",
            source: coordinator,
            target: engineer,
            sourceTaskId: "supervision",
            targetTaskId: root.taskId,
            state: ActivityState.SUCCEEDED,
            startedAt: 100,
            finishedAt: 9_000,
            endedAt: 10_000,
          },
          review("review-a", "pause", 2_000, 4_000),
        ],
        interactions: [interaction("pause", 1_000, 5_000)],
      }),
    );
    expect(result.connections.find((edge) => edge.id === "return:delegate")?.source).toBe(
      "pause:continued",
    );
    for (const edge of result.connections) {
      const from = result.activities.find((node) => node.id === edge.source);
      const to = result.activities.find((node) => node.id === edge.target);
      expect(from?.x).toBeLessThan(to?.x ?? 0);
    }
  });
});
