import { create } from "@bufbuild/protobuf";
import { Code } from "@connectrpc/connect";
import { expect, it, vi } from "vitest";
import { MessageSchema, Role, TaskSchema, TaskState } from "../gen/a2a_pb.js";
import { RespondInteractionRequestSchema } from "../gen/agentos/console/v1/console_service_pb.js";
import { ActivityState } from "../gen/agentos/execution/v1/state_pb.js";
import { messageCommands } from "../server/console/messages.js";
import { hitlExtension } from "../server/read-model/decode/hitl.js";
import { fixtureIds } from "./fixtures/kagent.js";
import { environment, until } from "./harness.js";

async function pending(kind: "question" | "approval") {
  const message = create(MessageSchema, {
    messageId: "request-message",
    role: Role.AGENT,
    extensions: [hitlExtension],
    metadata: {
      [hitlExtension]:
        kind === "question"
          ? { type: "ask_user_request", id: "question", questions: [{ question: "Scope?" }] }
          : {
              type: "tool_approval_request",
              tools: [{ id: "tool", name: "publish", call_id: "call" }],
            },
    },
  });
  const task = create(TaskSchema, {
    id: "task",
    contextId: fixtureIds.chatContext,
    history: [message],
    status: { state: TaskState.INPUT_REQUIRED, message },
  });
  const env = environment([task]);
  await env.sync.refresh();
  const interaction = env.index.entry(task.id)?.interactions[0];
  if (!interaction) throw new Error("Missing native interaction");
  const request = create(RespondInteractionRequestSchema, {
    taskId: task.id,
    requestId: interaction.requestId,
    decision:
      kind === "question"
        ? { case: "answer", value: { answers: [{ values: ["Current environment"] }] } }
        : { case: "approval", value: { approvals: [{ id: "tool", approved: true }] } },
  });
  return { ...env, request, task, commands: messageCommands(env.sync, env.clients) };
}

it.each(["question", "approval"] as const)(
  "rejects a repeated %s decision using native history even when the local view is stale",
  async (kind) => {
    const env = await pending(kind);
    try {
      const stale = env.index.entry(env.task.id);
      if (!stale) throw new Error("Missing pending task");
      await env.commands.respond(env.request);
      env.index.upsert({ ...stale, version: "stale-pending-view" });
      await expect(
        messageCommands(env.sync, env.clients).respond(env.request),
      ).rejects.toMatchObject({ code: Code.FailedPrecondition, rawMessage: "interaction.stale" });
      expect(env.fake.received).toHaveLength(1);
      expect(env.index.entry(env.task.id)?.interactions[0].state).toBe(ActivityState.SUCCEEDED);
    } finally {
      env.sync.close();
    }
  },
);

it.each(["question", "approval"] as const)(
  "accepts only one concurrent %s decision",
  async (kind) => {
    const env = await pending(kind);
    let release = () => {};
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const send = env.sync.send.bind(env.sync);
    const waiting = vi.spyOn(env.sync, "send").mockImplementation(async (...args) => {
      await hold;
      return send(...args);
    });
    const accepted = env.commands.respond(env.request);
    try {
      await until(() => waiting.mock.calls.length === 1);
      await expect(env.commands.respond(env.request)).rejects.toMatchObject({
        code: Code.Aborted,
      });
      expect(env.fake.received).toHaveLength(0);
    } finally {
      release();
      await accepted;
      expect(env.fake.received).toHaveLength(1);
      env.sync.close();
    }
  },
);
