import { clone, create, fromJson } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import { expect, it } from "vitest";
import { ArtifactSchema, TaskSchema, TaskState } from "../gen/a2a_pb.js";
import { ConversationSchema } from "../gen/agentos/console/v1/conversation_pb.js";
import { partTypeKey } from "../server/read-model/decode/messages.js";
import { conversation } from "../server/read-model/views/conversation.js";
import { mcpAppsEnvironment } from "./fixtures/mcp-apps.js";

it("retains a completed delegated App even when the child has no text answer", async () => {
  const env = await mcpAppsEnvironment();
  const child = env.fake.createSession(
    { namespace: "agentos", name: "inspection" },
    "child-app",
    "child",
  );
  await env.registry.bind(child, env.owner, env.session);
  const childTask = clone(TaskSchema, env.task);
  childTask.id = "child-app-task";
  childTask.contextId = child.id;
  for (const artifact of childTask.artifacts)
    artifact.parts = artifact.parts.filter((part) => part.content.case !== "text");
  env.fake.update(childTask, TaskState.COMPLETED);
  const root = clone(TaskSchema, env.task);
  root.artifacts = [
    create(ArtifactSchema, {
      artifactId: "delegation",
      name: "",
      description: "",
      extensions: [],
      metadata: {},
      parts: ["function_call", "function_response"].map((kind) => ({
        metadata: { [partTypeKey]: kind },
        content: {
          case: "data" as const,
          value: fromJson(ValueSchema, {
            id: "delegate-app",
            name: "invoke_session",
            ...(kind === "function_call"
              ? {
                  args: {
                    session_id: child.id,
                    message_id: "child-input",
                    message: "Show topology",
                  },
                }
              : {
                  response: {
                    output: {
                      sessionId: child.id,
                      taskId: childTask.id,
                      state: TaskState.COMPLETED,
                    },
                  },
                }),
          }),
        },
      })),
    }),
  ];
  env.fake.update(root, TaskState.COMPLETED);
  await env.sync.refresh();
  const view = await conversation(env.sync, env.session.agent, env.session.id);
  await env.apps.project(view);
  const results = view.messages
    .flatMap((message) => message.parts)
    .flatMap((part) => (part.content.case === "agentResult" ? [part.content.value] : []));
  expect(results).toHaveLength(1);
  expect(results[0].output).toBe("");
  expect(results[0].calls).toEqual([
    expect.objectContaining({
      id: env.callId,
      taskId: childTask.id,
      uiResourceUri: "ui://lab-views/topology.html",
    }),
  ]);
});

it("keeps Apps from an earlier native run when a child conversation continues", async () => {
  const env = await mcpAppsEnvironment();
  const latest = clone(TaskSchema, env.task);
  latest.id = "continued-child";
  latest.artifacts = [];
  latest.history = [];
  env.fake.update(latest, TaskState.COMPLETED);
  await env.sync.refresh();
  const view = create(ConversationSchema, {
    contextId: "parent",
    messages: [
      {
        id: "child-result",
        parts: [
          {
            id: "result",
            content: {
              case: "agentResult",
              value: { taskId: latest.id, contextId: latest.contextId, output: "Complete" },
            },
          },
        ],
      },
    ],
  });
  await env.apps.project(view);
  const result = view.messages[0].parts[0].content;
  expect(result.case).toBe("agentResult");
  if (result.case === "agentResult")
    expect(result.value.calls).toEqual([
      expect.objectContaining({
        taskId: env.task.id,
        uiResourceUri: "ui://lab-views/topology.html",
      }),
    ]);
});
