import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { TaskState } from "../gen/a2a_pb.js";
import { ActivityState } from "../gen/agentos/execution/v1/state_pb.js";
import { TaskExecutionSchema, TaskRelation } from "../gen/kagent/api/v1/execution_pb.js";
import { conversation } from "../server/read-model/views/conversation.js";
import { fixtureState, fixtureTasks, fixtureIds as ids } from "./fixtures/kagent.js";

async function view(index: ReturnType<typeof fixtureState>) {
  return conversation(index.graph(), undefined, ids.chatContext, async (entry) =>
    fixtureTasks().find((task) => task.id === entry.id),
  );
}

describe("conversation worker projection", () => {
  it("attaches operations by native parentage when no delegation call is available", async () => {
    const index = fixtureState();
    const parent = index.entry(ids.chat);
    if (!parent) throw new Error("Missing conversation fixture");
    index.upsert({ ...parent, calls: [] });
    const chat = await view(index);
    expect(chat.messages[0]?.tasks.map((task) => task.id)).toEqual([ids.chatRoot]);
  });

  it("keeps a completed result through a working continuation and preserves both completed phases", async () => {
    const index = fixtureState();
    const entry = index.entry(ids.chatRoot);
    if (!entry) throw new Error("Missing child fixture");
    index.upsert({
      ...entry,
      state: TaskState.COMPLETED,
      answer: "Initial findings",
      statusAt: 100,
      version: "initial-completed",
    });
    const results = async () =>
      (await view(index)).messages.flatMap((message) =>
        message.parts.filter((part) => part.content.case === "agentResult"),
      );
    const first = (await results()).find(
      (part) => part.content.case === "agentResult" && part.content.value.taskId === entry.id,
    );
    expect(first).toBeDefined();
    const continuation = {
      ...entry,
      id: "continued-worker",
      execution: create(TaskExecutionSchema, {
        root: entry.execution?.root,
        background: entry.execution?.background,
        task: { taskId: "continued-worker", sessionId: entry.contextId },
        parent: entry.execution?.task,
        resumedTask: entry.execution?.task,
        relation: TaskRelation.CONTINUATION,
      }),
      state: TaskState.WORKING,
      answer: "Unfinished follow-up",
      statusAt: 200,
      version: "continued-working",
    };
    index.upsert(continuation);
    expect(await results()).toContainEqual(first);
    expect(
      (await results()).some(
        (part) =>
          part.content.case === "agentResult" && part.content.value.taskId === continuation.id,
      ),
    ).toBe(false);
    index.upsert({
      ...continuation,
      state: TaskState.COMPLETED,
      answer: "Follow-up findings",
      version: "continued-completed",
    });
    const completed = await results();
    expect(completed).toContainEqual(first);
    expect(
      completed.flatMap((part) =>
        part.content.case === "agentResult" ? [part.content.value.output] : [],
      ),
    ).toEqual(expect.arrayContaining(["Initial findings", "Follow-up findings"]));
    expect(new Set(completed.map((part) => part.id)).size).toBe(completed.length);
    expect(await results()).toEqual(completed);
  });

  it("shows a child only as presence while working and emits its final answer at the delegation", async () => {
    const index = fixtureState();
    const entry = index.entry(ids.chatRoot);
    expect(entry).toBeDefined();
    if (!entry) throw new Error("Missing child fixture");
    index.upsert({
      ...entry,
      state: TaskState.WORKING,
      answer: "internal child draft",
      version: "child-working",
    });
    const working = await view(index);
    expect(working.runs.find((run) => run.taskId === entry.id)?.state).toBe(ActivityState.WORKING);
    expect(working.runs.every((run) => !run.prompt && !run.output && !run.calls.length)).toBe(true);
    expect(
      working.messages
        .flatMap((message) => message.parts)
        .some(
          (part) => part.content.case === "agentResult" && part.content.value.taskId === entry.id,
        ),
    ).toBe(false);
    index.upsert({
      ...entry,
      state: TaskState.COMPLETED,
      answer: "verified child result",
      version: "child-done",
    });
    const done = await view(index);
    const result = done.messages
      .flatMap((message) => message.parts)
      .find(
        (part) => part.content.case === "agentResult" && part.content.value.taskId === entry.id,
      );
    expect(result?.content).toMatchObject({
      case: "agentResult",
      value: { output: "verified child result", agentId: entry.agentId },
    });
    if (!result) throw new Error("Final result missing");
    const message = done.messages.find((message) => message.parts.includes(result));
    const position = message?.parts.indexOf(result) ?? -1;
    expect(position).toBeGreaterThan(0);
    expect(
      message?.parts.slice(0, position).findLast((part) => part.content.case !== "agentResult")
        ?.content.case,
    ).toBe("toolCall");
    expect(done.participants.some((agent) => agent.id === entry.agentId)).toBe(true);
  });
});
