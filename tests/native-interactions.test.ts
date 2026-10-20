import { clone, create } from "@bufbuild/protobuf";
import { expect, it } from "vitest";
import { MessageSchema, Role, TaskSchema, TaskState } from "../gen/a2a_pb.js";
import {
  RespondInteractionRequestSchema,
  SendMessageRequestSchema,
} from "../gen/agentos/console/v1/console_service_pb.js";
import { Governance, GovernanceConfigSchema } from "../gen/agentos/governance/v1/governance_pb.js";
import { SessionSchema } from "../gen/kagent/api/v1alpha1/sessions_pb.js";
import { messageCommands } from "../server/console/messages.js";
import { hitlExtension, hitlPayload } from "../server/read-model/decode/hitl.js";
import { fixtureAgents } from "./fixtures/kagent.js";
import { environment } from "./harness.js";

it("runs a selected Agent without a coordinator, external approvals or a solution pack", async () => {
  const { fake, sync, clients } = environment([]);
  const preset = fixtureAgents().find((agent) => agent.ref?.name === "inspection");
  if (!preset) throw new Error("Agent fixture missing");
  const writer = clone(
    (await import("../gen/kagent/api/v1alpha1/agents_pb.js")).AgentSchema,
    preset,
  );
  if (writer.ref) writer.ref.name = "writer";
  fake.agents.splice(0, fake.agents.length, writer);
  fake.load({ sessions: [], tasks: [] });
  await sync.refresh();
  try {
    const response = await messageCommands(sync, clients).send(
      create(SendMessageRequestSchema, {
        agent: { namespace: "agentos", name: "writer" },
        messageId: "copywriting-request",
        text: "Write a concise product description",
      }),
    );
    expect(response.contextId).toBeTruthy();
    expect(fake.agents.map((agent) => agent.ref?.name)).toEqual(["writer"]);
    expect(sync.index.session(response.contextId)?.agentId).toBe("agentos/writer");
    await expect(
      messageCommands(sync, clients).send(
        create(SendMessageRequestSchema, {
          agent: { namespace: "foreign", name: "writer" },
          messageId: "foreign",
          text: "Write",
        }),
      ),
    ).rejects.toThrow();
  } finally {
    sync.close();
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
  const env = environment([task]);
  env.fake.load({
    sessions: [
      create(SessionSchema, {
        id: task.contextId,
        agent: { namespace: "agentos", name: "inspection" },
      }),
    ],
    tasks: [task],
  });
  await env.sync.refresh();
  const interaction = env.index.entry(task.id)?.interactions[0];
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
  return { ...env, interaction, commands: messageCommands(env.sync, env.clients, governance) };
}

it("resumes native tool confirmation only after an exact human decision", async () => {
  const env = await pending();
  try {
    await env.commands.respond(
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
    env.sync.close();
  }
});

it("rejects mismatched tool decisions and browser overrides of an external authority", async () => {
  for (const external of [false, true]) {
    const env = await pending(external);
    try {
      await expect(
        env.commands.respond(
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
      env.sync.close();
    }
  }
});
