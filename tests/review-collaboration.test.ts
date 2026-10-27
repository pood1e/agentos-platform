import assert from "node:assert/strict";
import { create } from "@bufbuild/protobuf";
import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { describe, expect, it } from "vitest";
import { Role, TaskSchema, TaskState } from "../gen/a2a_pb.js";
import { InteractionKind } from "../gen/agentos/console/v1/task_pb.js";
import { createdAtKey } from "../server/read-model/decode/messages.js";
import { ingest } from "../server/read-model/entry.js";
import { taskTree } from "../server/read-model/tree.js";
import { fixtureState, fixtureIds as ids } from "./fixtures/kagent.js";

const reviewer = "agentos/reviewer";

describe("native review projection", () => {
  it("attaches an independent review to its paused operation without adding a task-list item", () => {
    const index = fixtureState();
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
            "agentos.dev/review-request": approval.requestId,
          },
        },
      ],
    });
    index.upsert(ingest(task, reviewer));
    const graph = index.graph();
    expect(graph.relations().parents.get(task.id)).toBe(source.id);
    expect(taskTree(graph, ids.approvalRoot)?.entries.map((entry) => entry.id)).toContain(task.id);
    expect(graph.relations().roots.map((root) => root.id)).not.toContain(task.id);
  });
});
