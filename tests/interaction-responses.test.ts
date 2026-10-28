import { clone, create } from "@bufbuild/protobuf";
import { Code } from "@connectrpc/connect";
import { expect, it, vi } from "vitest";
import { MessageSchema, Role, TaskSchema, TaskState, TaskStatusSchema } from "../gen/a2a_pb.js";
import {
  AnswerDecisionSchema,
  RespondInteractionRequestSchema,
} from "../gen/agentos/console/v1/console_service_pb.js";
import { ActivityState } from "../gen/agentos/execution/v1/state_pb.js";
import { messageCommands } from "../server/console/messages.js";
import { hitlExtension, hitlPayload } from "../server/read-model/decode/hitl.js";
import { ingest } from "../server/read-model/entry.js";
import { fixtureIds } from "./fixtures/kagent.js";
import { environment, operator, until } from "./harness.js";

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
  const env = await environment([task]);
  const interaction = (await env.projection.entry(task.id))?.interactions[0];
  if (!interaction) throw new Error("Missing native interaction");
  const request = create(RespondInteractionRequestSchema, {
    taskId: task.id,
    requestId: interaction.requestId,
    decision:
      kind === "question"
        ? { case: "answer", value: { answers: [{ values: ["Current environment"] }] } }
        : { case: "approval", value: { approvals: [{ id: "tool", approved: true }] } },
  });
  const commands = messageCommands(env.projection, env.clients, "agentos", env.executions);
  return {
    ...env,
    request,
    task,
    respond: (value: typeof request) => commands.respond(value, operator),
  };
}

it("forwards custom single-choice and mixed multi-choice answers through native HITL", async () => {
  const env = await pending("question");
  const question = create(MessageSchema, {
    messageId: "custom-question",
    role: Role.AGENT,
    extensions: [hitlExtension],
    metadata: {
      [hitlExtension]: {
        type: "ask_user_request",
        id: "question",
        questions: [
          { question: "命名方式", choices: ["按 IP 命名", "按机房命名"] },
          { question: "检查范围", choices: ["网络", "存储"], multiple: true },
          { question: "补充说明" },
        ],
      },
    },
  });
  env.task.history = [question];
  env.task.status = create(TaskStatusSchema, {
    ...env.task.status,
    state: TaskState.INPUT_REQUIRED,
    message: question,
  });
  const values = [["以实际主机名为准"], ["网络", "同时检查动环"], ["保持现有配置\n只做核验"]];
  env.request.decision = {
    case: "answer",
    value: create(AnswerDecisionSchema, { answers: values.map((values) => ({ values })) }),
  };
  try {
    await env.respond(env.request);
    expect(hitlPayload(env.fake.received.at(-1))).toMatchObject({
      type: "ask_user_response",
      value: { id: "question", answers: values.map((answer) => ({ answer })) },
    });
    expect(
      (await env.projection.entry(env.task.id))?.interactions[0].answers.map(
        (answer) => answer.values,
      ),
    ).toEqual(values);
    await expect(env.respond(env.request)).rejects.toMatchObject({
      code: Code.FailedPrecondition,
    });
  } finally {
    await env.close();
  }
});

it.each(["question", "approval"] as const)(
  "rejects a repeated %s decision using native history even when the local view is stale",
  async (kind) => {
    const env = await pending(kind);
    try {
      const stale = clone(TaskSchema, env.task);
      await env.respond(env.request);
      // The pending view may predate another client's decision.
      vi.spyOn(env.projection, "entry").mockResolvedValueOnce({
        ...ingest(stale, "agentos/assistant"),
        root: stale.contextId,
        subject: operator.subject,
      });
      await expect(env.respond(env.request)).rejects.toMatchObject({
        code: Code.FailedPrecondition,
        rawMessage: "interaction.stale",
      });
      expect(env.fake.received).toHaveLength(1);
      expect(ingest(env.fake.task(env.task.id), "agentos/assistant").interactions[0].state).toBe(
        ActivityState.SUCCEEDED,
      );
    } finally {
      await env.close();
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
    const send = env.projection.send;
    const waiting = vi.spyOn(env.projection, "send").mockImplementation(async (...args) => {
      await hold;
      return send(...args);
    });
    const accepted = env.respond(env.request);
    try {
      await until(() => waiting.mock.calls.length === 1);
      await expect(env.respond(env.request)).rejects.toMatchObject({
        code: Code.Aborted,
      });
      expect(env.fake.received).toHaveLength(0);
    } finally {
      release();
      await accepted;
      expect(env.fake.received).toHaveLength(1);
      await env.close();
    }
  },
);
