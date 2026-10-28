import { create } from "@bufbuild/protobuf";
import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { expect, it, vi } from "vitest";
import { Role, TaskSchema, TaskState } from "../gen/a2a_pb.js";
import {
  ChatMessagePartSchema,
  ChatMessageSchema,
  ConversationSchema,
} from "../gen/agentos/console/v1/conversation_pb.js";
import { InteractionKind, InteractionSchema } from "../gen/agentos/console/v1/task_pb.js";
import { ActivityState } from "../gen/agentos/execution/v1/state_pb.js";
import { conversationTranscript } from "../server/console/conversation-transcript.js";
import { conversation } from "../server/read-model/views/conversation.js";
import { conversationParts } from "../server/read-model/views/conversation-work.js";
import { interactionAnchors } from "../server/read-model/views/interaction-anchors.js";
import { convertMessage } from "../src/features/chat/runtime-message.js";
import { fixtureState, fixtureTasks, fixtureIds as ids } from "./fixtures/kagent.js";

it("keeps a delegated approval before a later user message as its state changes", async () => {
  const index = fixtureState();
  const child = index.entry(ids.chatRoot);
  const root = index.entry(ids.chat);
  if (!child || !root) throw new Error("Missing conversation fixtures");
  const request = create(InteractionSchema, {
    id: "child-approval",
    taskId: child.id,
    requestId: "review",
    kind: InteractionKind.APPROVAL,
    state: ActivityState.AWAITING_APPROVAL,
  });
  index.upsert({ ...child, interactions: [request], version: "pending" });
  index.upsert({
    ...root,
    id: "next-turn",
    createdAt: (root.createdAt ?? 0) + 1000,
    calls: [],
    interactions: [],
    userMessages: [{ id: "new-user-message", text: "Another question" }],
    parentTaskId: "",
    resumedTaskId: "",
    version: "next-turn",
  });
  const fullTask = async ({ id }: { id: string }) =>
    id === "next-turn"
      ? create(TaskSchema, {
          id,
          contextId: ids.chatContext,
          status: { state: TaskState.WORKING },
        })
      : fixtureTasks().find((task) => task.id === id);
  let partId = "";
  for (const state of [ActivityState.AWAITING_APPROVAL, ActivityState.SUCCEEDED]) {
    request.state = state;
    const view = await conversation(index.graph(), undefined, ids.chatContext, fullTask);
    const position = view.messages.findIndex((message) =>
      message.parts.some((part) => part.content.case === "interaction"),
    );
    expect(position).toBeGreaterThan(0);
    expect(position).toBeLessThan(
      view.messages.findIndex((message) => message.id === "new-user-message"),
    );
    const parts = view.messages.flatMap((message) => message.parts);
    const requests = parts.filter((part) => part.content.case === "interaction");
    expect(requests).toHaveLength(1);
    expect(requests[0].content).toEqual({ case: "interaction", value: request });
    partId ||= requests[0].id;
    expect(requests[0].id).toBe(partId);
  }
});

it("anchors local approval and question cards to their own calls and keeps them out of spoken text", () => {
  const index = fixtureState();
  const entry = index.entry(ids.chat);
  if (!entry) throw new Error("Missing conversation fixture");
  const approval = create(InteractionSchema, {
    id: "write-review",
    kind: InteractionKind.APPROVAL,
    tools: [{ callId: "write" }],
  });
  const question = create(InteractionSchema, {
    id: "question",
    kind: InteractionKind.QUESTION,
    requestedAt: timestampFromMs(200),
  });
  const calls = [
    { id: "ask-1", name: "ask_user", startedAt: 100 },
    { id: "write", name: "update_resource", startedAt: 150 },
    { id: "ask-2", name: "ask_user", startedAt: 300 },
  ];
  const parts = calls.map((call) =>
    create(ChatMessagePartSchema, {
      id: call.id,
      content: { case: "toolCall", value: { id: call.id, name: call.name } },
    }),
  );
  const projected = conversationParts(
    index.graph(),
    { ...entry, calls: calls as typeof entry.calls, interactions: [approval, question] },
    parts,
    new Set(),
  );
  expect(projected.map((part) => part.id)).toEqual([
    "ask-1",
    "interaction:question",
    "write",
    "interaction:write-review",
    "ask-2",
  ]);
  const message = convertMessage(create(ChatMessageSchema, { role: Role.AGENT, parts: projected }));
  expect(message.content).toEqual(
    expect.arrayContaining([
      { id: "interaction:question", type: "data", name: "interaction", data: question },
    ]),
  );
  expect(
    Array.isArray(message.content) && message.content.every((part) => part.type !== "text"),
  ).toBe(true);
});

it("anchors a reused worker's new approval to the later delegation without moving the older approval", () => {
  const index = fixtureState();
  const root = index.entry(ids.chat),
    child = index.entry(ids.chatRoot);
  if (!root || !child) throw new Error("Missing conversation fixtures");
  const first = create(InteractionSchema, { id: "first", requestedAt: timestampFromMs(200) });
  const second = create(InteractionSchema, { id: "second", requestedAt: timestampFromMs(400) });
  index.upsert({ ...child, interactions: [first, second], version: "reviews" });
  const call = root.calls[0];
  const earlier = { ...root, calls: [{ ...call, id: "first-call", startedAt: 100 }] };
  const later = {
    ...root,
    id: "later-root",
    calls: [{ ...call, id: "next-call", startedAt: 300 }],
  };
  const graph = index.graph();
  const target = vi.spyOn(graph, "target").mockReturnValue(child.id);
  try {
    const anchors = interactionAnchors(graph, [earlier, later]);
    expect(anchors.get(first.id)).toMatchObject({ entryId: earlier.id, callId: "first-call" });
    expect(anchors.get(second.id)).toMatchObject({ entryId: later.id, callId: "next-call" });
  } finally {
    target.mockRestore();
  }
});

it("updates native HITL cards without moving their transcript positions", () => {
  const interaction = create(InteractionSchema, {
    id: "confirmation",
    state: ActivityState.SUCCEEDED,
    approve: false,
  });
  const view = create(ConversationSchema, {
    interactions: [interaction],
    messages: [
      {
        parts: [
          { id: "result", content: { case: "toolCall", value: { id: "call" } } },
          {
            id: "confirmation",
            content: {
              case: "interaction",
              value: {
                ...interaction,
                state: ActivityState.AWAITING_APPROVAL,
                approve: true,
              },
            },
          },
        ],
      },
    ],
  });
  const result = conversationTranscript(view);
  expect(result.messages[0].parts.map((part) => part.id)).toEqual(["result", "confirmation"]);
  expect(result.messages[0].parts[1].content.value).toBe(result.interactions[0]);
});
