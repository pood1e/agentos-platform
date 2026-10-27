import assert from "node:assert/strict";
import { describe, expect, it } from "vitest";
import { TaskState } from "../gen/a2a_pb.js";
import { ActivityState } from "../gen/agentos/execution/v1/state_pb.js";
import { taskTree } from "../server/read-model/tree.js";
import { conversation } from "../server/read-model/views/conversation.js";
import { listTasks, taskSummary } from "../server/read-model/views/task.js";
import { decidedTasks } from "./fake-kagent/scenario.js";
import { fixtureIndex, fixtureIds as ids } from "./fixtures/kagent.js";
import { environment } from "./harness.js";

describe("operation ownership", () => {
  it("keeps a completed worker's caller active until its native continuation arrives", async () => {
    const { sync, index } = environment(decidedTasks());
    await sync.refresh();
    try {
      const tree = taskTree(index, ids.approvalRoot);
      assert(tree);
      expect(taskSummary(index, tree).state).toBe(ActivityState.WORKING);
    } finally {
      sync.close();
    }
  });

  it("keeps a failed native continuation in its operation", () => {
    const index = fixtureIndex();
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
    expect(index.relations().continuations.get(root.id)).toContain("failed-continuation");
    expect(taskTree(index, root.id)?.entries.map((entry) => entry.id)).toContain(
      "failed-continuation",
    );
  });

  it("links a running invocation in a reused session before its response arrives", () => {
    const index = fixtureIndex();
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
        messageId: "",
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
    expect(index.target(operation, pending)).toBe(worker.id);
    const tasks = listTasks(index, { query: "", pageToken: "", pageSize: 100 }).tasks;
    expect(tasks.map((task) => task.id)).not.toContain(worker.id);
    expect(index.operationRoot(worker.id)?.id).toBe(operation.id);
    const members = taskTree(index, operation.id)?.entries.map((entry) => entry.id);
    expect(members).toContain(worker.id);
    expect(members).not.toContain("old-worker");

    index.upsert({
      ...worker,
      id: "ambiguous-worker",
      version: "ambiguous-worker",
      createdAt: 2150,
    });
    expect(index.target(operation, pending)).toBeUndefined();
  });

  it("keeps coordinator follow-ups in one operation and preserves separate sessions", async () => {
    const index = fixtureIndex();
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
    const tasks = listTasks(index, { query: "", pageToken: "", pageSize: 100 }).tasks;
    expect(tasks.map((task) => task.id)).toContain(root.id);
    expect(tasks.map((task) => task.id)).toContain("separate-operation");
    expect(tasks.map((task) => task.id)).not.toContain(follow.id);
    expect(index.operationRoot(follow.id)?.id).toBe(root.id);
    expect(taskTree(index, root.id)?.latest.answer).toBe(follow.answer);
    const view = await conversation(
      { index, fullTask: async () => undefined } as never,
      { namespace: "agentos", name: "assistant" },
      ids.chatContext,
    );
    const turn = view.messages.find((message) => message.id === "follow-up-chat-message");
    expect(turn?.tasks.map((task) => task.id)).toEqual([root.id]);
  });
});
