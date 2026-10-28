import { create, fromJson } from "@bufbuild/protobuf";
import { timestampFromMs, ValueSchema } from "@bufbuild/protobuf/wkt";
import { describe, expect, it } from "vitest";
import { ArtifactSchema, Role, TaskSchema, TaskState } from "../gen/a2a_pb.js";
import { partTypeKey } from "../server/read-model/decode/messages.js";
import { ingest } from "../server/read-model/entry.js";
import { conversation } from "../server/read-model/views/conversation.js";
import { syntheticOperations } from "./fake-kagent/scenario.js";
import { fixtureIds, fixtureState, fixtureTasks } from "./fixtures/kagent.js";
import { bindTasks, environment } from "./harness.js";

describe("streamed task content", () => {
  it("retains visible assistant progress during tool calls and after the final reply without changing its message ID", async () => {
    const index = fixtureState();
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
        index.graph(),
        { namespace: "agentos", name: "assistant" },
        task.contextId,
        async ({ id }) => (id === task.id ? task : fixtureTasks().find((item) => item.id === id)),
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
    const revision = () => ingest(task, "agentos/inspection").version;
    const previous = revision();
    task.artifacts[0].parts[0].content = { case: "text", value: "updated" };
    expect(ingest(task, "agentos/inspection").answer).toBe("updated");
    expect(revision()).not.toBe(previous);
    expect(revision()).toBe(revision());
  });

  it("reads current native task payloads on demand", async () => {
    const env = await environment();
    const seeded = syntheticOperations(220);
    env.fake.load({
      sessions: [...env.fake.sessions.values(), ...seeded.sessions],
      tasks: [...env.fake.tasks.values(), ...seeded.tasks],
    });
    await bindTasks(env.store, env.fake, seeded.tasks);
    try {
      env.fake.fetched.length = 0;
      const entry = await env.projection.entry("synthetic-task-0");
      expect(entry).toBeDefined();
      expect(env.fake.fetched).toContain("synthetic-task-0");
      if (!entry) return;
      expect((await env.projection.fullTask(entry))?.id).toBe("synthetic-task-0");
      expect(env.fake.fetched).toContain("synthetic-task-0");
      await env.projection.fullTask(entry);
      expect(env.fake.fetched.filter((id) => id === "synthetic-task-0")).toHaveLength(3);
    } finally {
      await env.close();
    }
  });
});
