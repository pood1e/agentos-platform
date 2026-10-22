import { create, toJson } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import { expect, it } from "vitest";
import {
  ArtifactSchema,
  MessageSchema,
  PartSchema,
  Role,
  TaskSchema,
  TaskState,
} from "../gen/a2a_pb.js";
import { hitlExtension } from "../server/read-model/decode/hitl.js";
import { partTypeKey, timelineKey } from "../server/read-model/decode/messages.js";
import { chatParts } from "../server/read-model/views/chat-parts.js";
import { batches, notes, orderedChat, toolPart } from "./fixtures/ordered-chat.js";

it("retains six narration blocks and ten calls in their native parallel batches", () => {
  const task = orderedChat();
  const parts = chatParts(task, "agentos/assistant");
  expect(
    parts.map((part) =>
      part.content.case === "toolCall" ? part.content.value.id : part.content.value,
    ),
  ).toEqual(
    batches.flatMap((size, batch) => [
      notes[batch],
      ...Array.from({ length: size }, (_, index) => `read-${batch}-${index}`),
    ]),
  );
  expect(new Set(parts.map((part) => part.id)).size).toBe(parts.length);
  for (const part of parts) {
    if (part.content.case !== "toolCall") continue;
    const call = part.content.value;
    expect(toJson(ValueSchema, call.args ?? create(ValueSchema))).toEqual({ namespace: call.id });
    expect(toJson(ValueSchema, call.output ?? create(ValueSchema))).toEqual({
      namespace: call.id,
      healthy: true,
    });
  }
});

it("keeps part IDs across text replacement, completion and a fresh projection", () => {
  const task = orderedChat();
  const before = chatParts(task, "agentos/assistant");
  const final = create(ArtifactSchema, {
    artifactId: "answer",
    parts: [{ content: { case: "text", value: "发现异常。" } }],
  });
  task.artifacts.push(final);
  const draft = chatParts(task, "agentos/assistant");
  expect(draft.slice(0, -1)).toEqual(before);
  final.parts[0].content = { case: "text", value: "发现异常，告警条件需要修正。" };
  if (task.status) task.status.state = TaskState.COMPLETED;
  const completed = chatParts(task, "agentos/assistant");
  expect(completed.map((part) => part.id)).toEqual(draft.map((part) => part.id));
  expect(completed.slice(0, -1)).toEqual(before);
  expect(completed.at(-1)?.content).toEqual({
    case: "text",
    value: "发现异常，告警条件需要修正。",
  });
  expect(chatParts(create(TaskSchema, task), "agentos/assistant")).toEqual(completed);
});

it("renders mirrored history and artifact calls once, retaining history-only calls", () => {
  const task = orderedChat();
  task.history.push(
    create(MessageSchema, {
      messageId: "mirror",
      role: Role.AGENT,
      parts: task.artifacts[0].parts,
    }),
    create(MessageSchema, {
      messageId: "history-call",
      role: Role.AGENT,
      parts: [toolPart("function_call", "history-only")],
    }),
  );
  const calls = chatParts(task, "agentos/assistant").flatMap((part) =>
    part.content.case === "toolCall" ? [part.content.value.id] : [],
  );
  expect(calls).toHaveLength(11);
  expect(calls[0]).toBe("history-only");
  expect(new Set(calls).size).toBe(11);
});

it("uses native timeline positions to interleave history and artifacts when all are present", () => {
  const task = create(TaskSchema, {
    history: [
      {
        messageId: "call",
        role: Role.AGENT,
        metadata: { [timelineKey]: "2026-10-22T00:00:02Z" },
        parts: [toolPart("function_call", "middle")],
      },
    ],
    artifacts: [
      {
        artifactId: "before",
        metadata: { [timelineKey]: "2026-10-22T00:00:01Z" },
        parts: [{ content: { case: "text", value: "开始检查。" } }],
      },
      {
        artifactId: "after",
        metadata: { [timelineKey]: "2026-10-22T00:00:03Z" },
        parts: [{ content: { case: "text", value: "检查完毕。" } }],
      },
    ],
  });
  expect(chatParts(task, "assistant").map((part) => part.content.case)).toEqual([
    "progress",
    "toolCall",
    "progress",
  ]);
});

it("retains separate anonymous calls rather than matching concurrent events by tool name", () => {
  const task = create(TaskSchema, {
    artifacts: [
      {
        artifactId: "parallel",
        parts: [toolPart("function_call", ""), toolPart("function_call", "")],
      },
    ],
  });
  const parts = chatParts(task, "assistant");
  expect(parts).toHaveLength(2);
  expect(new Set(parts.map((part) => part.id)).size).toBe(2);
  expect(chatParts(task, "assistant")).toEqual(parts);
});

it("does not turn malformed tool payloads or approval messages into readable text", () => {
  const task = create(TaskSchema, {
    status: { state: TaskState.COMPLETED },
    history: [
      {
        messageId: "approval",
        role: Role.AGENT,
        extensions: [hitlExtension],
        metadata: { [hitlExtension]: { type: "tool_approval_request" } },
        parts: [{ content: { case: "text", value: "审批内部消息" } }],
      },
    ],
    artifacts: [
      {
        artifactId: "malformed",
        parts: [
          create(PartSchema, {
            metadata: { [partTypeKey]: "function_call" },
            content: { case: "text", value: "工具内部数据" },
          }),
        ],
      },
    ],
  });
  expect(chatParts(task, "assistant")).toEqual([]);
});

it("marks only the final text in a history-only task as the completed answer", () => {
  const task = create(TaskSchema, {
    status: { state: TaskState.COMPLETED },
    history: [
      {
        messageId: "reply",
        role: Role.AGENT,
        parts: [
          { content: { case: "text", value: "先检查。" } },
          toolPart("function_call", "read"),
          toolPart("function_response", "read"),
          { content: { case: "text", value: "资源健康。" } },
        ],
      },
    ],
  });
  expect(chatParts(task, "assistant").map((part) => part.content.case)).toEqual([
    "progress",
    "toolCall",
    "text",
  ]);
  expect(chatParts(task, "assistant").at(-1)?.content.value).toBe("资源健康。");
});

it("preserves native failures without speaking progress as a completed answer", () => {
  const task = orderedChat();
  task.status = create(TaskSchema, {
    status: {
      state: TaskState.FAILED,
      message: { role: Role.AGENT, parts: [{ content: { case: "text", value: "上游不可用。" } }] },
    },
  }).status;
  const parts = chatParts(task, "assistant");
  expect(parts.at(-1)?.content).toEqual({ case: "progress", value: "上游不可用。" });
  expect(parts.some((part) => part.content.case === "text")).toBe(false);
});
