import { create } from "@bufbuild/protobuf";
import { expect, it, vi } from "vitest";
import { Role } from "../gen/a2a_pb.js";
import {
  ChatMessagePartSchema,
  ChatMessageSchema,
  ConversationSchema,
} from "../gen/agentos/console/v1/conversation_pb.js";
import { VoiceTurnSchema } from "../gen/agentos/voice/v1/worker_pb.js";
import type { Chat } from "../src/features/chat/use-chat.js";
import { VoiceChatBridge } from "../src/features/chat/voice/chat-bridge.js";
import { until } from "./harness.js";

function fixture() {
  const reply = vi.fn();
  const changed = vi.fn();
  const error = vi.fn();
  const submit = vi.fn<Chat["submit"]>(async () => true);
  const chat: Chat = {
    conversation: create(ConversationSchema, { ready: true, operate: true }),
    outgoing: undefined,
    messages: [],
    ready: true,
    busy: false,
    pending: [],
    blocked: false,
    sending: false,
    error: "",
    reset: vi.fn(),
    submit,
    cancel: vi.fn(async () => {}),
  };
  const bridge = new VoiceChatBridge(reply, changed, error);
  bridge.update(chat);
  const add = (id = "turn-1", text = "检查交换机") =>
    bridge.add(create(VoiceTurnSchema, { id, text }));
  return { bridge, chat, reply, changed, error, submit, add };
}

it("uses existing chat submission and speaks only the matching completed assistant prose once", async () => {
  const { bridge, chat, reply, submit, add } = fixture();
  add();
  add();
  await until(() => submit.mock.calls.length === 1);
  const id = submit.mock.calls[0]?.[1] ?? "";
  expect(bridge.ownsMessage(id)).toBe(true);
  await Promise.resolve();
  const user = create(ChatMessageSchema, { id, role: Role.USER, taskId: "root-1" });
  const answer = create(ChatMessageSchema, {
    id: "answer:root-1",
    role: Role.AGENT,
    taskId: "root-1",
    parts: [
      { id: "progress", content: { case: "progress", value: "调用 MCP 检查设备" } },
      { id: "tool", content: { case: "toolCall", value: {} } },
    ],
  });
  bridge.update({ ...chat, busy: true, blocked: true, messages: [user, answer] });
  expect(reply).not.toHaveBeenCalled();
  answer.parts.push(
    create(ChatMessagePartSchema, {
      id: "answer",
      content: { case: "text", value: '**设备正常。**\n\n```json\n{"raw":true}\n```' },
    }),
  );
  const complete = { ...chat, messages: [user, answer] };
  bridge.update(complete);
  bridge.update(complete);
  expect(reply).toHaveBeenCalledExactlyOnceWith("turn-1", "设备正常。");
  expect(submit).toHaveBeenCalledOnce();
});

it("queues voice turns during foreground work without starting concurrent chat runs", async () => {
  const { bridge, chat, submit, add } = fixture();
  bridge.update({ ...chat, blocked: true, busy: true });
  add("turn-1", "第一台设备");
  add("turn-2", "第二台设备");
  expect(submit).not.toHaveBeenCalled();
  bridge.update(chat);
  await Promise.resolve();
  expect(submit).toHaveBeenCalledTimes(1);
  const user = create(ChatMessageSchema, {
    id: submit.mock.calls[0]?.[1],
    role: Role.USER,
    taskId: "root",
  });
  const answer = create(ChatMessageSchema, {
    role: Role.AGENT,
    taskId: "root",
    parts: [{ content: { case: "text", value: "完成" } }],
  });
  bridge.update({ ...chat, messages: [user, answer] });
  expect(submit).toHaveBeenCalledTimes(2);
  expect(submit.mock.calls.map(([text]) => text)).toEqual(["第一台设备", "第二台设备"]);
});

it("retries failed sends with the same message ID and does not retry automatically", async () => {
  const { bridge, chat, submit, changed, add } = fixture();
  submit.mockResolvedValueOnce(false);
  add();
  await until(() => changed.mock.calls.some(([, failed]) => failed));
  bridge.update(chat);
  expect(submit).toHaveBeenCalledOnce();
  bridge.retry();
  expect(submit).toHaveBeenCalledTimes(2);
  expect(submit.mock.calls[0]?.[1]).toBe(submit.mock.calls[1]?.[1]);
});

it("preserves unsent turns on hangup and never submits or speaks after closing", async () => {
  const { bridge, chat, submit, reply, add } = fixture();
  bridge.update({ ...chat, blocked: true });
  add("turn-1", "你好");
  add("turn-2", "مرحبا");
  expect(bridge.close()).toBe("你好\nمرحبا");
  bridge.update(chat);
  add("turn-3", "late");
  expect(submit).not.toHaveBeenCalled();
  expect(reply).not.toHaveBeenCalled();
});

it("cancels the interrupted foreground turn and suppresses its late answer before sending the next", async () => {
  const { bridge, chat, submit, reply, add } = fixture();
  let release = () => {};
  const cancel = vi.fn(() => new Promise<void>((resolve) => (release = resolve)));
  add();
  await until(() => submit.mock.calls.length === 1);
  await Promise.resolve();
  const user = create(ChatMessageSchema, {
    id: submit.mock.calls[0]?.[1],
    role: Role.USER,
    taskId: "interrupted-root",
  });
  const running = { ...chat, cancel, busy: true, blocked: true, messages: [user] };
  bridge.update(running);
  bridge.interrupt();
  bridge.interrupt();
  add("turn-2", "停下，换个问题");
  expect(cancel).toHaveBeenCalledExactlyOnceWith("interrupted-root");
  const late = create(ChatMessageSchema, {
    role: Role.AGENT,
    taskId: user.taskId,
    parts: [{ content: { case: "text", value: "过期答复" } }],
  });
  bridge.update({ ...running, messages: [user, late] });
  expect(reply).not.toHaveBeenCalled();
  release();
  await Promise.resolve();
  expect(submit).toHaveBeenCalledOnce();
  bridge.update({ ...chat, cancel, messages: [user, late] });
  expect(submit).toHaveBeenCalledTimes(2);
  expect(submit.mock.calls[1]?.[0]).toBe("停下，换个问题");
});

it("waits for the interrupted send to be admitted and cancels only its matching task", async () => {
  const { bridge, chat, submit, add } = fixture();
  let accepted = (_value: boolean) => {};
  submit.mockImplementationOnce(() => new Promise<boolean>((resolve) => (accepted = resolve)));
  add();
  bridge.interrupt();
  add("turn-2", "下一句");
  bridge.update({
    ...chat,
    messages: [create(ChatMessageSchema, { role: Role.USER, taskId: "unrelated" })],
  });
  expect(chat.cancel).not.toHaveBeenCalled();
  accepted(true);
  await Promise.resolve();
  expect(chat.cancel).not.toHaveBeenCalled();
  bridge.update({
    ...chat,
    blocked: true,
    messages: [
      create(ChatMessageSchema, {
        id: submit.mock.calls[0]?.[1],
        role: Role.USER,
        taskId: "admitted-root",
      }),
    ],
  });
  expect(chat.cancel).toHaveBeenCalledExactlyOnceWith("admitted-root");
  expect(submit).toHaveBeenCalledOnce();
});

it("retries a failed interruption without resubmitting the accepted message", async () => {
  const { bridge, chat, submit, error, changed, add } = fixture();
  vi.mocked(chat.cancel).mockRejectedValueOnce(new Error("unavailable"));
  add();
  await until(() => submit.mock.calls.length === 1);
  await Promise.resolve();
  const running = {
    ...chat,
    blocked: true,
    busy: true,
    messages: [
      create(ChatMessageSchema, {
        id: submit.mock.calls[0]?.[1],
        role: Role.USER,
        taskId: "root",
      }),
    ],
  };
  bridge.update(running);
  bridge.interrupt();
  await until(() => error.mock.calls.length === 1);
  expect(error).toHaveBeenCalledWith("task.cancelFailed");
  expect(changed).toHaveBeenLastCalledWith(1, true);
  bridge.update(running);
  expect(chat.cancel).toHaveBeenCalledOnce();
  bridge.retry();
  await Promise.resolve();
  expect(chat.cancel).toHaveBeenCalledTimes(2);
  expect(submit).toHaveBeenCalledOnce();
});
