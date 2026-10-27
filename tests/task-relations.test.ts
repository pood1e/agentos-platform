import assert from "node:assert/strict";
import { describe, expect, it } from "vitest";
import { TaskState } from "../gen/a2a_pb.js";
import { ActivityState } from "../gen/agentos/execution/v1/state_pb.js";
import { taskTree } from "../server/read-model/tree.js";
import { conversation } from "../server/read-model/views/conversation.js";
import { taskSummary } from "../server/read-model/views/task.js";
import { decidedTasks } from "./fake-kagent/scenario.js";
import { fixtureState, fixtureIds as ids } from "./fixtures/kagent.js";
import { environment } from "./harness.js";

const roots = (index: ReturnType<typeof fixtureState>) =>
  index
    .graph()
    .relations()
    .roots.map((root) => root.id);

describe("operation ownership", () => {
  it("keeps a completed worker's caller active until its native continuation arrives", async () => {
    const env = await environment(decidedTasks());
    try {
      await env.reconcile.refresh();
      const graph = await env.projection.graphOf({ taskId: ids.approvalRoot });
      const tree = graph && taskTree(graph, ids.approvalRoot);
      assert(graph && tree);
      expect(taskSummary(graph, tree).state).toBe(ActivityState.WORKING);
    } finally {
      await env.close();
    }
  });

  it("keeps a failed native continuation in its operation", () => {
    const index = fixtureState();
    const root = index.entry(ids.chatRoot);
    assert(root);
    index.upsert({
      ...root,
      id: "failed-continuation",
      version: "failed-continuation",
      state: TaskState.FAILED,
      createdAt: (root.statusAt ?? 0) + 1000,
      statusAt: (root.statusAt ?? 0) + 2000,
      calls: [],
      interactions: [],
      messageIds: [],
      userMessages: [],
      parentTaskId: root.id,
      resumedTaskId: root.id,
    });
    const graph = index.graph();
    expect(graph.relations().continuations.get(root.id)).toContain("failed-continuation");
    expect(taskTree(graph, root.id)?.entries.map((entry) => entry.id)).toContain(
      "failed-continuation",
    );
  });

  it("links a running invocation in a reused session by its message ID before the response arrives", () => {
    const index = fixtureState();
    const source = index.entry(ids.approved);
    const parent = index.entry(ids.approvalRoot);
    const call = parent?.calls.find((item) => item.delegation);
    assert(source && parent && call);
    const worker = {
      ...source,
      id: "current-worker",
      contextId: "reused-worker-session",
      prompt: "Collect the requested facts",
      createdAt: 2100,
      statusAt: 2200,
      version: "current-worker",
      state: TaskState.WORKING,
      parentTaskId: "",
      resumedTaskId: "",
      calls: [],
      interactions: [],
      messageIds: ["current-message"],
    };
    index.upsert({ ...worker, id: "old-worker", version: "old-worker", createdAt: 1000 });
    index.upsert(worker);
    const pending = {
      ...call,
      id: "pending-invoke",
      startedAt: 2000,
      state: ActivityState.WORKING,
      delegation: {
        kind: "invoke" as const,
        sessionId: worker.contextId,
        agentName: "",
        messageId: "current-message",
        taskId: "",
        message: worker.prompt,
      },
    };
    const operation = {
      ...parent,
      id: "pending-operation",
      contextId: "new-coordinator-session",
      version: "pending-operation",
      calls: [pending],
    };
    index.upsert(operation);
    const graph = index.graph();
    expect(graph.target(operation, pending)).toBe(worker.id);
    expect(roots(index)).not.toContain(worker.id);
    expect(graph.operationRoot(worker.id)?.id).toBe(operation.id);
    const members = taskTree(graph, operation.id)?.entries.map((entry) => entry.id);
    expect(members).toContain(worker.id);
    expect(members).not.toContain("old-worker");

    const unidentified = { ...pending, delegation: { ...pending.delegation, messageId: "" } };
    index.upsert({ ...operation, calls: [unidentified] });
    expect(index.graph().target(operation, unidentified)).toBeUndefined();
  });

  it("keeps coordinator follow-ups in one operation and preserves separate sessions", async () => {
    const index = fixtureState();
    const root = index.entry(ids.chatRoot);
    const chat = index.entry(ids.chat);
    const call = chat?.calls.find((item) => item.delegation);
    assert(root && chat && call);
    const later = Math.max(root.statusAt ?? 0, root.createdAt ?? 0, chat.statusAt ?? 0) + 1000;
    const follow = {
      ...root,
      id: "follow-up-round",
      prompt: "Continue device discovery",
      answer: "Device discovery completed",
      createdAt: later,
      statusAt: later + 1000,
      version: "follow-up-round",
      messageIds: ["follow-up-message"],
      userMessages: [{ id: "follow-up-message", text: "Continue device discovery" }],
      calls: [],
      interactions: [],
      parentTaskId: "",
      resumedTaskId: "",
    };
    index.upsert(follow);
    index.upsert({
      ...follow,
      id: "separate-operation",
      contextId: "different-coordinator-session",
      version: "separate-operation",
      messageIds: ["independent-message"],
    });
    index.upsert({
      ...chat,
      id: "follow-up-chat-turn",
      createdAt: later,
      statusAt: later + 100,
      version: "follow-up-chat-turn",
      messageIds: ["follow-up-chat-message"],
      userMessages: [{ id: "follow-up-chat-message", text: "Continue device discovery" }],
      calls: [
        {
          ...call,
          delegation: {
            kind: "invoke" as const,
            sessionId: root.contextId,
            agentName: "coordinator",
            messageId: "follow-up-message",
            taskId: follow.id,
          },
        },
      ],
    });
    const graph = index.graph();
    expect(roots(index)).toContain(root.id);
    expect(roots(index)).toContain("separate-operation");
    expect(roots(index)).not.toContain(follow.id);
    expect(graph.operationRoot(follow.id)?.id).toBe(root.id);
    expect(taskTree(graph, root.id)?.latest.answer).toBe(follow.answer);
    const view = await conversation(
      graph,
      { namespace: "agentos", name: "assistant" },
      ids.chatContext,
      async () => undefined,
    );
    const turn = view.messages.find((message) => message.id === "follow-up-chat-message");
    expect(turn?.tasks.map((task) => task.id)).toEqual([root.id]);
  });
});
