import { create } from "@bufbuild/protobuf";
import { expect, it, vi } from "vitest";
import { TaskSchema, TaskState } from "../gen/a2a_pb.js";
import { ActivityState } from "../gen/agentos/execution/v1/state_pb.js";
import { InvokeSessionOutputSchema } from "../gen/agentos/kagent/v1/wire_pb.js";
import { cancelTree } from "../server/read-model/cancel.js";
import { resumedTaskKey } from "../server/read-model/decode/messages.js";
import { ingest } from "../server/read-model/entry.js";
import { taskTree } from "../server/read-model/tree.js";
import { startContinuations } from "../server/team-sessions/continuation.js";
import { decidedTasks, pendingApprovalTasks } from "./fake-kagent/scenario.js";
import { fixtureIds } from "./fixtures/kagent.js";
import { environment, silent, until } from "./harness.js";

it.each(["approval", "transport failure"])(
  "returns a nested %s outcome to the chat entry point exactly once",
  async (reason) => {
    const { sync, index } = environment(decidedTasks());
    await sync.refresh();
    const parent = index.entry(fixtureIds.approvalRoot);
    const call = parent?.calls.find(
      (call) => call.delegation?.invocation?.taskId === fixtureIds.approved,
    );
    if (!parent || !call?.delegation) throw new Error("Missing native delegation fixture");
    if (reason === "transport failure") {
      const child = index.entry(fixtureIds.approved);
      if (!child) throw new Error("Missing completed native child");
      index.upsert({ ...child, version: `${child.version}-without-decision`, decision: undefined });
      index.upsert({
        ...parent,
        version: `${parent.version}-transport-failure`,
        calls: parent.calls.map((item) =>
          item.id === call.id
            ? {
                ...item,
                state: ActivityState.FAILED,
                delegation: item.delegation
                  ? { ...item.delegation, invocation: undefined }
                  : undefined,
              }
            : item,
        ),
      });
    }
    index.upsert({
      ...parent,
      id: "chat-root",
      agentId: "agentos/assistant",
      contextId: fixtureIds.chatContext,
      parentTaskId: "",
      resumedTaskId: "",
      decision: undefined,
      prompt: "继续原任务",
      answer: "等待审核",
      state: TaskState.COMPLETED,
      calls: [
        {
          ...call,
          id: "delegate-coordinator",
          delegation: {
            ...call.delegation,
            sessionId: parent.contextId,
            taskId: parent.id,
            invocation: create(InvokeSessionOutputSchema, {
              taskId: parent.id,
              contextId: parent.contextId,
              state: TaskState.COMPLETED,
            }),
          },
        },
      ],
    });
    const send = vi.spyOn(sync, "send").mockImplementation(async (tenant, message) => {
      const task = create(TaskSchema, {
        id: `continuation-${send.mock.calls.length}`,
        contextId: message.contextId,
        status: { state: TaskState.COMPLETED },
        history: [message],
        artifacts: [
          {
            artifactId: "result",
            parts: [{ content: { case: "text", value: "Verified final result" } }],
          },
        ],
      });
      index.upsert(ingest(task, tenant));
      index.flush();
      return task;
    });
    let stop = startContinuations(sync, silent);
    try {
      await until(() => send.mock.calls.length >= 2);
      expect(send.mock.calls.map(([, message]) => message.metadata?.[resumedTaskKey])).toEqual([
        fixtureIds.approved,
        parent.id,
      ]);
      expect(send.mock.calls[1]?.[1].contextId).toBe(fixtureIds.chatContext);
      stop();
      stop = startContinuations(sync, silent);
      expect(send).toHaveBeenCalledTimes(2);
    } finally {
      stop();
      sync.close();
    }
  },
);

it.each(["canceled", "rejected", "canceled ancestor"])(
  "keeps a %s operation stopped after a child finishes",
  async (reason) => {
    const { sync, index } = environment(decidedTasks());
    await sync.refresh();
    const parent = index.entry(fixtureIds.approvalRoot);
    if (!parent) throw new Error("Missing coordinator fixture");
    if (reason === "canceled ancestor") {
      index.upsert({ ...parent, id: "stopped-owner", state: TaskState.CANCELED, calls: [] });
      index.upsert({
        ...parent,
        version: `${parent.version}-stopped-owner`,
        state: TaskState.COMPLETED,
        parentTaskId: "stopped-owner",
      });
    } else {
      index.upsert({
        ...parent,
        version: `${parent.version}-${reason}`,
        state: reason === "canceled" ? TaskState.CANCELED : TaskState.REJECTED,
      });
    }
    const send = vi.spyOn(sync, "send");
    const stop = startContinuations(sync, silent);
    try {
      index.flush();
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(send).not.toHaveBeenCalled();
    } finally {
      stop();
      sync.close();
    }
  },
);

it("allows a new request in a session whose earlier operation was canceled", async () => {
  const { sync, index } = environment(decidedTasks());
  await sync.refresh();
  const parent = index.entry(fixtureIds.approvalRoot);
  if (!parent) throw new Error("Missing coordinator fixture");
  index.upsert({
    ...parent,
    id: "canceled-earlier-round",
    state: TaskState.CANCELED,
    calls: [],
    createdAt: (parent.createdAt ?? 0) - 1,
  });
  expect(index.relations().parents.get(parent.id)).toBe("canceled-earlier-round");
  expect(index.relations().causalParents.get(parent.id)).toBeUndefined();
  const send = vi.spyOn(sync, "send").mockImplementation(async (tenant, message) => {
    const task = create(TaskSchema, {
      id: "new-request-continuation",
      contextId: message.contextId,
      status: { state: TaskState.COMPLETED },
      history: [message],
    });
    index.upsert(ingest(task, tenant));
    return task;
  });
  const stop = startContinuations(sync, silent);
  try {
    await until(() => send.mock.calls.length > 0);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[1].contextId).toBe(parent.contextId);
  } finally {
    stop();
    sync.close();
  }
});

it("does not restart a completed caller after its pending foreground worker is canceled", async () => {
  const { sync, index, clients } = environment(pendingApprovalTasks());
  await sync.refresh();
  const send = vi.spyOn(sync, "send");
  const stop = startContinuations(sync, silent);
  try {
    const tree = taskTree(index, fixtureIds.approvalRoot);
    if (!tree) throw new Error("missing operation");
    await cancelTree(clients, sync, tree);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(send).not.toHaveBeenCalled();
    expect(index.entry(fixtureIds.approvalRoot)?.state).toBe(TaskState.COMPLETED);
    expect(index.entry(fixtureIds.approved)?.state).toBe(TaskState.CANCELED);
  } finally {
    stop();
    sync.close();
  }
});
