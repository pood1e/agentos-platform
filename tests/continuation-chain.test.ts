import { create } from "@bufbuild/protobuf";
import { expect, it } from "vitest";
import { type Message, TaskSchema, TaskState } from "../gen/a2a_pb.js";
import { ActivityState } from "../gen/agentos/execution/v1/state_pb.js";
import { InvokeSessionOutputSchema } from "../gen/agentos/kagent/v1/wire_pb.js";
import { resumedTaskKey } from "../server/read-model/decode/messages.js";
import { ingest } from "../server/read-model/entry.js";
import { continuations } from "../server/team-sessions/continuation.js";
import { decidedTasks, pendingApprovalTasks } from "./fake-kagent/scenario.js";
import { fixtureIds, fixtureState } from "./fixtures/kagent.js";

/** Runs the coordinator the way the queue does: work selected from each new tree state. */
function coordinate(
  state: ReturnType<typeof fixtureState>,
  authorize?: Parameters<typeof continuations>[1],
) {
  const sent: Message[] = [];
  const coordinator = continuations(
    {
      graphOf: async () => state.graph(),
      async send(tenant, message) {
        sent.push(message);
        const task = create(TaskSchema, {
          id: `continuation-${sent.length}`,
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
        state.upsert(ingest(task, tenant));
        return task;
      },
    },
    authorize,
  );
  return {
    sent,
    async drain() {
      for (let round = 0; round < 5; round++) {
        const graph = state.graph();
        const jobs = coordinator.select(graph, new Set(graph.all().map((entry) => entry.id)));
        if (!jobs.length) return;
        for (const job of jobs) await coordinator.run(job);
      }
    },
  };
}

it.each(["approval", "transport failure"])(
  "returns a nested %s outcome to the chat entry point exactly once",
  async (reason) => {
    const state = fixtureState(decidedTasks());
    const parent = state.entry(fixtureIds.approvalRoot);
    const call = parent?.calls.find(
      (call) => call.delegation?.invocation?.taskId === fixtureIds.approved,
    );
    if (!parent || !call?.delegation) throw new Error("Missing native delegation fixture");
    if (reason === "transport failure") {
      const child = state.entry(fixtureIds.approved);
      if (!child) throw new Error("Missing completed native child");
      state.upsert({ ...child, decision: undefined });
      state.upsert({
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
    state.upsert({
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
    const run = coordinate(state);
    await run.drain();
    expect(run.sent.map((message) => message.metadata?.[resumedTaskKey])).toEqual([
      fixtureIds.approved,
      parent.id,
    ]);
    expect(run.sent[1]?.contextId).toBe(fixtureIds.chatContext);
    await run.drain();
    expect(run.sent).toHaveLength(2);
  },
);

it.each(["canceled", "rejected", "canceled ancestor"])(
  "keeps a %s operation stopped after a child finishes",
  async (reason) => {
    const state = fixtureState(decidedTasks());
    const parent = state.entry(fixtureIds.approvalRoot);
    if (!parent) throw new Error("Missing coordinator fixture");
    if (reason === "canceled ancestor") {
      state.upsert({ ...parent, id: "stopped-owner", state: TaskState.CANCELED, calls: [] });
      state.upsert({ ...parent, state: TaskState.COMPLETED, parentTaskId: "stopped-owner" });
    } else
      state.upsert({
        ...parent,
        state: reason === "canceled" ? TaskState.CANCELED : TaskState.REJECTED,
      });
    const run = coordinate(state);
    await run.drain();
    expect(run.sent).toEqual([]);
  },
);

it("allows a new request in a session whose earlier operation was canceled", async () => {
  const state = fixtureState(decidedTasks());
  const parent = state.entry(fixtureIds.approvalRoot);
  if (!parent) throw new Error("Missing coordinator fixture");
  state.upsert({
    ...parent,
    id: "canceled-earlier-round",
    state: TaskState.CANCELED,
    calls: [],
    createdAt: (parent.createdAt ?? 0) - 1,
  });
  expect(state.graph().relations().parents.get(parent.id)).toBe("canceled-earlier-round");
  expect(state.graph().relations().causalParents.get(parent.id)).toBeUndefined();
  const run = coordinate(state);
  await run.drain();
  expect(run.sent).toHaveLength(1);
  expect(run.sent[0]?.contextId).toBe(parent.contextId);
});

it("does not restart a completed caller after its pending foreground worker is canceled", async () => {
  const state = fixtureState(pendingApprovalTasks());
  const child = state.entry(fixtureIds.approved);
  if (!child) throw new Error("Missing pending worker");
  state.upsert({ ...child, state: TaskState.CANCELED });
  const run = coordinate(state);
  await run.drain();
  expect(run.sent).toEqual([]);
});

it("does not resume through runtime-controlled task links when the execution roots differ", async () => {
  let checks = 0;
  const run = coordinate(fixtureState(decidedTasks()), async (_parent, contexts) => {
    checks++;
    expect(contexts.length).toBeGreaterThan(0);
    throw new Error("Different execution root");
  });
  await expect(run.drain()).rejects.toThrow("Different execution root");
  expect(checks).toBe(1);
  expect(run.sent).toEqual([]);
});
