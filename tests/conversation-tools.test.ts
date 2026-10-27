import { create, fromJson, type JsonValue, toJson } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import { expect, it, vi } from "vitest";
import { ArtifactSchema, PartSchema, Role, TaskSchema, TaskState } from "../gen/a2a_pb.js";
import { ChatMessageSchema } from "../gen/agentos/console/v1/conversation_pb.js";
import { ActivityState } from "../gen/agentos/execution/v1/state_pb.js";
import { ToolCallSchema } from "../gen/agentos/execution/v1/task_pb.js";
import { partTypeKey } from "../server/read-model/decode/messages.js";
import { conversation } from "../server/read-model/views/conversation.js";
import { convertMessage } from "../src/features/chat/runtime-message.js";
import { fixtureGraph, fixtureTasks, fixtureIds as ids } from "./fixtures/kagent.js";
import { environment } from "./harness.js";

const event = (kind: string, response?: JsonValue) =>
  create(PartSchema, {
    metadata: { [partTypeKey]: kind },
    content: {
      case: "data",
      value: fromJson(ValueSchema, {
        id: "resource-read",
        name: "k8s_get_resources",
        args: { namespace: "operations" },
        ...(response && { response }),
      }),
    },
  });

it("projects calls without narration while running, then reloads their native result after completion", async () => {
  const task = create(TaskSchema, {
    id: "tool-only",
    contextId: ids.chatContext,
    status: { state: TaskState.WORKING },
    history: [
      {
        role: Role.USER,
        messageId: "question",
        parts: [{ content: { case: "text", value: "检查资源" } }],
      },
    ],
    artifacts: [{ artifactId: "call", parts: [event("function_call")] }],
  });
  for (const completed of [false, true]) {
    if (completed) {
      task.artifacts.push(
        create(ArtifactSchema, {
          artifactId: "result",
          parts: [event("function_response", { output: { healthy: true } })],
        }),
      );
      if (task.status) task.status.state = TaskState.COMPLETED;
    }
    const env = await environment([task]);
    try {
      await env.reconcile.refresh();
      const graph = await env.projection.graphOf({ contextId: ids.chatContext });
      if (!graph) throw new Error("Missing conversation tree");
      const chat = await conversation(graph, undefined, ids.chatContext, env.projection.fullTask);
      const reply = chat.messages.find((message) => message.role === Role.AGENT);
      expect(reply?.id).toBe("answer:tool-only");
      expect(reply?.parts).toHaveLength(1);
      const call = reply?.parts[0]?.content;
      expect(call?.case).toBe("toolCall");
      if (call?.case !== "toolCall") throw new Error("Expected a tool call");
      expect(call.value).toMatchObject({
        id: "resource-read",
        name: "k8s_get_resources",
        state: completed ? ActivityState.SUCCEEDED : ActivityState.WORKING,
      });
      expect(toJson(ValueSchema, call.value.args ?? create(ValueSchema))).toEqual({
        namespace: "operations",
      });
      if (completed)
        expect(toJson(ValueSchema, call.value.output ?? create(ValueSchema))).toEqual({
          healthy: true,
        });
    } finally {
      await env.close();
    }
  }
});

it("loads tool payloads only from the visible conversation entries", async () => {
  const fullTask = vi.fn(async ({ id }: { id: string }) =>
    fixtureTasks().find((task) => task.id === id),
  );
  const chat = await conversation(fixtureGraph(), undefined, ids.chatContext, fullTask);
  expect(
    chat.messages
      .find((message) => message.role === Role.AGENT)
      ?.parts.filter((part) => part.content.case === "toolCall").length,
  ).toBeGreaterThan(0);
  expect(fullTask.mock.calls.map(([entry]) => entry.id)).toEqual([ids.chat]);
});

it.each([
  [ActivityState.WORKING, undefined, undefined],
  [ActivityState.AWAITING_APPROVAL, { error: "confirmation required" }, false],
  [ActivityState.SUCCEEDED, false, false],
  [ActivityState.SUCCEEDED, null, false],
  [ActivityState.SUCCEEDED, 0, false],
  [ActivityState.FAILED, "upstream unavailable", true],
  [ActivityState.REJECTED, undefined, true],
  [ActivityState.CANCELED, undefined, false],
])(
  "keeps native call state %s in assistant-ui without adding it to spoken text",
  (state, output, error) => {
    const call = create(ToolCallSchema, {
      id: "call-1",
      name: "k8s_get_resources",
      state,
      args: fromJson(ValueSchema, { namespace: "operations", token: "private-token" }),
      output: output === undefined ? undefined : fromJson(ValueSchema, output),
    });
    const message = create(ChatMessageSchema, {
      id: "reply",
      role: Role.AGENT,
      parts: [
        { id: "progress", content: { case: "progress", value: "正在检查资源" } },
        { id: "call", content: { case: "toolCall", value: call } },
        { id: "answer", content: { case: "text", value: "检查完成" } },
      ],
    });
    const converted = convertMessage(message);
    expect(converted.content).toEqual([
      { id: "progress", type: "reasoning", text: "正在检查资源" },
      expect.objectContaining({
        type: "tool-call",
        toolCallId: call.id,
        toolName: call.name,
        artifact: call,
        isError: error ?? false,
      }),
      { id: "answer", type: "text", text: "检查完成" },
    ]);
    const part = Array.isArray(converted.content) ? converted.content[1] : undefined;
    expect(part.argsText).not.toContain("private-token");
    expect(part.argsText).toContain("[REDACTED]");
    expect(part.result).toEqual(
      output === undefined && state !== ActivityState.WORKING ? null : output,
    );
    expect(part.isPreliminary).toBe(
      state === ActivityState.WORKING || state === ActivityState.AWAITING_APPROVAL,
    );
  },
);
