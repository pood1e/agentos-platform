import { create } from "@bufbuild/protobuf";
import { expect, it, vi } from "vitest";
import { TaskSchema, TaskState } from "../gen/a2a_pb.js";
import { ActivityState } from "../gen/agentos/console/v1/state_pb.js";
import { InvokeSessionOutputSchema } from "../gen/agentos/kagent/v1/wire_pb.js";
import { resumedTaskKey } from "../server/read-model/decode/messages.js";
import { ingest } from "../server/read-model/entry.js";
import { startContinuations } from "../server/team-sessions/continuation.js";
import { decidedTasks } from "./fake-kagent/scenario.js";
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
      index.upsert({ ...child, decision: undefined });
      index.upsert({
        ...parent,
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
