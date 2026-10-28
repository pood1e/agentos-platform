import { clone, create, fromJson } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import { expect, it, vi } from "vitest";
import { ArtifactSchema, TaskSchema, TaskState } from "../gen/a2a_pb.js";
import {
  ChatMessagePartSchema,
  ConversationSchema,
} from "../gen/agentos/console/v1/conversation_pb.js";
import { ToolServerSchema } from "../gen/kagent/api/v1/tools_pb.js";
import { partTypeKey } from "../server/read-model/decode/messages.js";
import { TaskGraph } from "../server/read-model/graph.js";
import { conversation } from "../server/read-model/views/conversation.js";
import { mcpAppsEnvironment } from "./fixtures/mcp-apps.js";
import { publishTargets } from "./harness.js";

it("discovers independent App services together before either metadata response arrives", async () => {
  const env = await mcpAppsEnvironment();
  env.fake.toolServers.push(create(ToolServerSchema, { ref: "agentos/lab-other" }));
  env.fake.resources.save(
    "agentgatewaybackends",
    {
      metadata: {
        name: "lab-other",
        labels: { "agentos.dev/project": "views", "agentos.dev/environment": "lab" },
      },
      spec: { mcp: { targets: [{ name: "lab-other" }] } },
    },
    true,
  );
  publishTargets(env.fake, [
    {
      server: "lab-other",
      service: "lab-other",
      environment: "lab",
      project: "views",
      catalog: true,
      tools: [{ name: "show_topology", write: false, requireApproval: false }],
    },
  ]);
  let release = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Set<string>();
  const original = env.clients.tools.listMCPAppTools.bind(env.clients.tools);
  const metadata = vi
    .spyOn(env.clients.tools, "listMCPAppTools")
    .mockImplementation(async (request, options) => {
      started.add(request.server?.ref?.name ?? "");
      await released;
      return original(request, options);
    });
  const view = create(ConversationSchema, {
    messages: [
      {
        id: "two-services",
        parts: ["lab-views", "lab-other"].map((service) =>
          create(ChatMessagePartSchema, {
            id: service,
            content: { case: "toolCall", value: { id: service, name: `${service}_show_topology` } },
          }),
        ),
      },
    ],
  });
  const projected = env.apps.project(view, new TaskGraph(), env.projection.fullTask);
  try {
    await expect.poll(() => started.size, { timeout: 1000 }).toBe(2);
  } finally {
    release();
    await projected;
    metadata.mockRestore();
  }
  const first = view.messages[0].parts[0].content;
  expect(first.case === "toolCall" && first.value.uiResourceUri).toBe(
    "ui://lab-views/topology.html",
  );
});

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
                      session_id: child.id,
                      task_id: childTask.id,
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
  await env.reconcile.refresh();
  const graph = await env.projection.graphOf({ contextId: env.session.id });
  if (!graph) throw new Error("Missing conversation tree");
  const view = await conversation(
    graph,
    env.session.agent,
    env.session.id,
    env.projection.fullTask,
  );
  await env.apps.project(view, graph, env.projection.fullTask);
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
  await env.reconcile.refresh();
  const graph = await env.projection.graphOf({ contextId: env.session.id });
  if (!graph) throw new Error("Missing conversation tree");
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
  await env.apps.project(view, graph, env.projection.fullTask);
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
