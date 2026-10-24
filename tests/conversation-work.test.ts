import { describe, expect, it } from "vitest";
import { TaskState } from "../gen/a2a_pb.js";
import { ActivityState } from "../gen/agentos/execution/v1/state_pb.js";
import { conversation } from "../server/read-model/views/conversation.js";
import { fixtureIndex, fixtureTasks, fixtureIds as ids } from "./fixtures/kagent.js";

async function view(index: ReturnType<typeof fixtureIndex>) {
  return conversation(
    {
      index,
      fullTask: async (id: string) => fixtureTasks().find((task) => task.id === id),
    } as never,
    undefined,
    ids.chatContext,
  );
}

describe("conversation worker projection", () => {
  it("shows a child only as presence while working and emits its final answer at the delegation", async () => {
    const index = fixtureIndex();
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
