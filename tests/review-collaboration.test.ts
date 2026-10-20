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
import { collaborationDetail } from "./fixtures/collaboration.js";
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
  dependsOn: [],
  returned: false,
  sourceContextId: "context-operation",
  targetContextId: `context-${id}`,
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

describe("approval instance collaboration", () => {
  const layout = (links: Link[], interactions: ReturnType<typeof interaction>[]) =>
    collaborationLayout(
      collaborationFlow(
        collaborationDetail(links, {
          root: { ...root, contextId: "context-operation" },
          interactions,
        }),
      ),
    );

  it("shows both the reviewer instance and the actual human approval", async () => {
    const pending = await layout(
      [review("review-a", "pause-a", 2_000)],
      [interaction("pause-a", 1_000)],
    );
    expect(pending.activities.map((node) => node.kind)).toEqual([
      "engineer",
      "engineer",
      "approval",
    ]);
    expect(pending.activities[1]).toMatchObject({
      contextId: "context-review-a",
      state: ActivityState.WORKING,
    });
    expect(
      pending.connections.flatMap((edge) => edge.records).find((edge) => edge.phase === "approval")
        ?.source,
    ).toBe("session:context-review-a");
  });

  it("returns the human decision to the existing execution instance", async () => {
    const finished = await layout(
      [review("review-a", "pause-a", 2_000, 4_000)],
      [interaction("pause-a", 1_000, 5_000)],
    );
    expect(finished.activities).toHaveLength(3);
    expect(finished.connections.find((edge) => edge.source === "interaction:pause-a")?.target).toBe(
      "session:context-operation",
    );
  });

  it("keeps different reviewer contexts distinct and can reuse the same reviewer context", async () => {
    const links = [
      review("review-a", "pause-a", 2_000, 4_000),
      { ...review("review-b", "pause-b", 7_000, 8_000), targetContextId: "context-review-a" },
    ];
    const result = await layout(links, [
      interaction("pause-a", 1_000, 5_000),
      interaction("pause-b", 6_000, 9_000),
    ]);
    expect(result.activities.filter((node) => node.agentId === reviewer)).toHaveLength(1);
    expect(result.activities.filter((node) => node.kind === "approval")).toHaveLength(2);
    expect(result.activities.find((node) => node.agentId === reviewer)?.taskIds).toEqual([
      "task-review-a",
      "task-review-b",
    ]);
  });

  it("keeps parallel review instances in the same row", async () => {
    const result = await layout(
      [review("review-a", "pause", 2_000, 8_000), review("review-b", "pause", 3_000, 7_000)],
      [interaction("pause", 1_000, 9_000)],
    );
    const reviewers = result.activities.filter((node) => node.agentId === reviewer);
    expect(reviewers.map((node) => node.row)).toEqual([2, 2]);
    expect(new Set(reviewers.map((node) => node.y)).size).toBe(1);
    expect(result.connections.filter((edge) => edge.target === "interaction:pause")).toHaveLength(
      2,
    );
  });

  it("keeps coordinates stable across review status updates", async () => {
    const before = await layout(
      [review("review-a", "pause", 2_000)],
      [interaction("pause", 1_000)],
    );
    const after = await layout(
      [review("review-a", "pause", 2_000, 4_000)],
      [interaction("pause", 1_000)],
    );
    expect(after.key).toBe(before.key);
    expect(after.activities.map(({ id, x, y }) => [id, x, y])).toEqual(
      before.activities.map(({ id, x, y }) => [id, x, y]),
    );
  });

  it("keeps human-only approval visible without fabricating a reviewer", async () => {
    expect(
      (await layout([], [interaction("human-pause", 1_000)])).activities.map((node) => node.kind),
    ).toEqual(["engineer", "approval"]);
  });
});
