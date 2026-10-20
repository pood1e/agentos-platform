import assert from "node:assert/strict";
import { describe, expect, it } from "vitest";
import { TaskState } from "../gen/a2a_pb.js";
import { ConversationKind } from "../gen/agentos/console/v1/conversation_pb.js";
import { ActivityState } from "../gen/agentos/console/v1/state_pb.js";
import { DelegationKind } from "../gen/agentos/console/v1/task_pb.js";
import { conversation } from "../server/read-model/views/conversation.js";
import { listTasks, taskDetail } from "../server/read-model/views/task.js";
import { fixtureIndex, fixtureIds as ids } from "./fixtures/kagent.js";

describe("operation ownership", () => {
  it("preserves a failed native continuation in the DAG", () => {
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
    expect(
      taskDetail(index, root.id)?.delegations.find(
        (link) => link.targetTaskId === "failed-continuation",
      ),
    ).toMatchObject({ kind: DelegationKind.RESUME, state: ActivityState.FAILED });
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
        kind: DelegationKind.INVOKE,
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
    const detail = taskDetail(index, worker.id);
    expect(detail?.summary?.id).toBe(operation.id);
    expect(detail?.runs.map((run) => run.taskId)).toContain(worker.id);
    expect(detail?.runs.map((run) => run.taskId)).not.toContain("old-worker");
    expect(detail?.completedAt).toBeUndefined();

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
            kind: DelegationKind.INVOKE,
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
    const detail = taskDetail(index, follow.id);
    expect(detail?.summary?.id).toBe(root.id);
    expect(detail?.answer).toBe(follow.answer);
    expect(detail?.delegations).toContainEqual(
      expect.objectContaining({
        kind: DelegationKind.RESUME,
        sourceTaskId: root.id,
        targetTaskId: follow.id,
      }),
    );
    const view = await conversation(
      { index, fullTask: async () => undefined } as never,
      ConversationKind.ASSISTANT,
      ids.chatContext,
    );
    const turn = view.messages.find((message) => message.id === "follow-up-chat-message");
    expect(turn?.tasks.map((task) => task.id)).toEqual([root.id]);
  });
});
