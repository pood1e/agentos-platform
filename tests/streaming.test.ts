import { create, fromJson } from "@bufbuild/protobuf";
import { timestampFromMs, ValueSchema } from "@bufbuild/protobuf/wkt";
import { describe, expect, it } from "vitest";
import { ArtifactSchema, Role, TaskSchema, TaskState } from "../gen/a2a_pb.js";
import { partTypeKey } from "../server/read-model/decode/messages.js";
import { ingest } from "../server/read-model/entry.js";
import { TaskIndex } from "../server/read-model/index.js";
import { conversation } from "../server/read-model/views/conversation.js";
import { syntheticOperations } from "./fake-kagent/scenario.js";
import { fixtureIds, fixtureIndex, fixtureTasks } from "./fixtures/kagent.js";
import { environment } from "./harness.js";

describe("streamed task content", () => {
  it("retains visible assistant progress during tool calls and after the final reply without changing its message ID", async () => {
    const index = fixtureIndex();
    const task = create(TaskSchema, {
      id: "streaming-chat",
      contextId: fixtureIds.chatContext,
      status: { state: TaskState.WORKING },
      history: [
        {
          messageId: "question",
          role: Role.USER,
          parts: [{ content: { case: "text", value: "Check health" } }],
        },
      ],
      artifacts: [
        { artifactId: "progress", parts: [{ content: { case: "text", value: "先读取资源。" } }] },
      ],
    });
    const view = async () => {
      index.upsert(ingest(task, "agentos/assistant"));
      const result = await conversation(
        {
          index,
          fullTask: async (id: string) =>
            id === task.id ? task : fixtureTasks().find((item) => item.id === id),
        } as never,
        { namespace: "agentos", name: "assistant" },
        task.contextId,
      );
      return result.messages.find(
        (message) => message.taskId === task.id && message.role === Role.AGENT,
      );
    };
    const before = await view();
    expect(before?.parts.map((part) => part.content)).toEqual([
      { case: "progress", value: "先读取资源。" },
    ]);
    task.artifacts.push(
      create(ArtifactSchema, {
        artifactId: "call",
        parts: [
          {
            metadata: { [partTypeKey]: "function_call" },
            content: {
              case: "data",
              value: fromJson(ValueSchema, { id: "query", name: "k8s_get_resources", args: {} }),
            },
          },
        ],
      }),
    );
    expect(await view()).toMatchObject({
      id: before?.id,
      parts: [
        before?.parts[0],
        expect.objectContaining({ content: expect.objectContaining({ case: "toolCall" }) }),
      ],
    });
    expect(index.entry(task.id)?.answer).toBe("");
    task.artifacts.push(
      create(ArtifactSchema, {
        artifactId: "result",
        parts: [
          {
            metadata: { [partTypeKey]: "function_response" },
            content: {
              case: "data",
              value: fromJson(ValueSchema, {
                id: "query",
                name: "k8s_get_resources",
                response: { output: [] },
              }),
            },
          },
        ],
      }),
    );
    expect(await view()).toMatchObject({
      id: before?.id,
      parts: [
        before?.parts[0],
        expect.objectContaining({ content: expect.objectContaining({ case: "toolCall" }) }),
      ],
    });
    task.artifacts.push(
      create(ArtifactSchema, {
        artifactId: "answer",
        parts: [{ content: { case: "text", value: "资源健康。" } }],
      }),
    );
    const draft = await view();
    expect(draft?.parts.map((part) => part.content.case)).toEqual([
      "progress",
      "toolCall",
      "progress",
    ]);
    expect(draft?.parts[0]).toEqual(before?.parts[0]);
    if (task.status) task.status.state = TaskState.COMPLETED;
    const completed = await view();
    expect(completed?.id).toBe(before?.id);
    expect(completed?.parts.map((part) => part.id)).toEqual(draft?.parts.map((part) => part.id));
    expect(completed?.parts.map((part) => part.content.case)).toEqual([
      "progress",
      "toolCall",
      "text",
    ]);
    expect(completed?.parts.at(-1)?.content.value).toBe("资源健康。");
    expect(index.entry(task.id)?.answer).toBe("资源健康。");
  });
  it("observes a text replacement with the same status, history length and part count", () => {
    const task = create(TaskSchema, {
      id: "stream",
      contextId: "context",
      status: { state: TaskState.WORKING, timestamp: timestampFromMs(1000) },
      artifacts: [{ artifactId: "answer", parts: [{ content: { case: "text", value: "first" } }] }],
    });
    const index = new TaskIndex();
    index.upsert(ingest(task, "agentos/inspection"));
    const previous = index.entry(task.id)?.version;
    task.artifacts[0].parts[0].content = { case: "text", value: "updated" };
    expect(index.upsert(ingest(task, "agentos/inspection"))).toBe(true);
    expect(index.entry(task.id)?.answer).toBe("updated");
    expect(index.entry(task.id)?.version).not.toBe(previous);
    expect(index.upsert(ingest(task, "agentos/inspection"))).toBe(false);
  });

  it("evicts old full payloads while retaining their compact history entries", async () => {
    const { fake, index, sync } = environment();
    const seeded = syntheticOperations(220);
    fake.load({
      sessions: [...fake.sessions.values(), ...seeded.sessions],
      tasks: [...fake.tasks.values(), ...seeded.tasks],
    });
    await sync.refresh();
    try {
      expect(index.entry("synthetic-task-0")).toBeDefined();
      expect(fake.fetched).toHaveLength(0);
      expect((await sync.fullTask("synthetic-task-0"))?.id).toBe("synthetic-task-0");
      expect(fake.fetched).toContain("synthetic-task-0");
      await sync.fullTask("synthetic-task-0");
      expect(fake.fetched.filter((id) => id === "synthetic-task-0")).toHaveLength(1);
    } finally {
      sync.close();
    }
  });
});
