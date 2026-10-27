import { clone, create } from "@bufbuild/protobuf";
import { Code } from "@connectrpc/connect";
import { expect, it } from "vitest";
import { MessageSchema, Role, TaskSchema, TaskState } from "../gen/a2a_pb.js";
import {
  RespondInteractionRequestSchema,
  SendMessageRequestSchema,
} from "../gen/agentos/console/v1/console_service_pb.js";
import { Governance, GovernanceConfigSchema } from "../gen/agentos/governance/v1/governance_pb.js";
import { SessionSchema } from "../gen/kagent/api/v1/sessions_pb.js";
import { messageCommands } from "../server/console/messages.js";
import { hitlExtension, hitlPayload } from "../server/read-model/decode/hitl.js";
import { fixtureAgents } from "./fixtures/kagent.js";
import { bindTasks, environment, fakeKagent, operator } from "./harness.js";

it("keeps cancelled tasks terminal when a late reply reaches the runtime fixture", () => {
  const env = fakeKagent();
  const task = [...env.fake.tasks.values()][0];
  env.fake.update(task, TaskState.CANCELED);
  const before = task.history.length;
  expect(() =>
    env.fake.accept(
      create(MessageSchema, {
        taskId: task.id,
        contextId: task.contextId,
        messageId: "late-reply",
        role: Role.USER,
        parts: [{ content: { case: "text", value: "Late response" } }],
      }),
    ),
  ).toThrowError(expect.objectContaining({ code: Code.FailedPrecondition }));
  expect(task.status?.state).toBe(TaskState.CANCELED);
  expect(task.history).toHaveLength(before);
});

it("runs a selected Agent without a coordinator, external approvals or a solution pack", async () => {
  const { fake, clients, projection, reconcile, executions, close } = await environment([]);
  const preset = fixtureAgents().find((agent) => agent.ref?.name === "inspection");
  if (!preset) throw new Error("Agent fixture missing");
  const writer = clone((await import("../gen/kagent/api/v1/agents_pb.js")).AgentSchema, preset);
  if (writer.ref) writer.ref.name = "writer";
  fake.agents.splice(0, fake.agents.length, writer);
  fake.load({ sessions: [], tasks: [] });
  await reconcile.refresh();
  const commands = messageCommands(projection, clients, "agentos", executions);
  try {
    const response = await commands.send(
      create(SendMessageRequestSchema, {
        agent: { namespace: "agentos", name: "writer" },
        messageId: "copywriting-request",
        text: "Write a concise product description",
      }),
      operator,
    );
    expect(response.contextId).toBeTruthy();
    expect(fake.agents.map((agent) => agent.ref?.name)).toEqual(["writer"]);
    expect((await projection.session(response.contextId))?.agentId).toBe("agentos/writer");
    await expect(
      commands.send(
        create(SendMessageRequestSchema, {
          agent: { namespace: "foreign", name: "writer" },
          messageId: "foreign",
          text: "Write",
        }),
        operator,
      ),
    ).rejects.toThrow();
  } finally {
    await close();
  }
});

async function pending(external = false) {
  const question = create(MessageSchema, {
    messageId: "confirmation",
    role: Role.AGENT,
    extensions: [hitlExtension],
    metadata: {
      [hitlExtension]: {
        type: "tool_approval_request",
        tools: [
          {
            id: "publish",
            call_id: "publish-call",
            name: "publishing-cms_publish",
            args: { document: "release-notes" },
          },
        ],
      },
    },
  });
  const task = create(TaskSchema, {
    id: "publish-task",
    contextId: "publish-context",
    status: { state: TaskState.INPUT_REQUIRED, message: question },
    history: [question],
  });
  const env = await environment([task]);
  env.fake.load({
    sessions: [
      create(SessionSchema, {
        id: task.contextId,
        agent: { namespace: "agentos", name: "inspection" },
      }),
    ],
    tasks: [task],
  });
  await bindTasks(env.store, env.fake, [task]);
  await env.reconcile.refresh();
  const interaction = (await env.projection.entry(task.id))?.interactions[0];
  if (!interaction) throw new Error("Native confirmation is missing");
  const governance = create(GovernanceConfigSchema, {
    environments: external
      ? [
          {
            environment: { name: "publishing", governance: Governance.APPROVAL },
            approvalUrl: "https://reviews.example",
          },
        ]
      : [],
  });
  const commands = messageCommands(
    env.projection,
    env.clients,
    "agentos",
    env.executions,
    governance,
  );
  return {
    ...env,
    interaction,
    respond: (request: Parameters<typeof commands.respond>[0]) =>
      commands.respond(request, operator),
  };
}

it("resumes native tool confirmation only after an exact human decision", async () => {
  const env = await pending();
  try {
    await env.respond(
      create(RespondInteractionRequestSchema, {
        taskId: env.interaction.taskId,
        requestId: env.interaction.requestId,
        decision: { case: "approval", value: { approvals: [{ id: "publish", approved: true }] } },
      }),
    );
    expect(hitlPayload(env.fake.received.at(-1))).toMatchObject({
      type: "tool_approval_response",
      value: { approvals: [{ id: "publish", approved: true }] },
    });
  } finally {
    await env.close();
  }
});

it("rejects mismatched tool decisions and browser overrides of an external authority", async () => {
  for (const external of [false, true]) {
    const env = await pending(external);
    try {
      await expect(
        env.respond(
          create(RespondInteractionRequestSchema, {
            taskId: env.interaction.taskId,
            requestId: env.interaction.requestId,
            decision: {
              case: "approval",
              value: { approvals: [{ id: external ? "publish" : "foreign", approved: true }] },
            },
          }),
        ),
      ).rejects.toThrow();
      expect(env.fake.received).toHaveLength(0);
    } finally {
      await env.close();
    }
  }
});
