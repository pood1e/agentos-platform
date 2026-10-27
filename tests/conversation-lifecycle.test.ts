import { randomUUID } from "node:crypto";
import { create, fromJson, toJson } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import { Code, createClient, createRouterTransport } from "@connectrpc/connect";
import { afterEach, expect, it, vi } from "vitest";
import {
  ArtifactSchema,
  Role,
  SendMessageResponseSchema,
  TaskSchema,
  TaskState,
} from "../gen/a2a_pb.js";
import { ConsoleService } from "../gen/agentos/console/v1/console_service_pb.js";
import { PackSchema } from "../gen/agentos/console/v1/pack_pb.js";
import { ExecutionIdentitySchema } from "../gen/agentos/execution/v1/identity_pb.js";
import { ActivityState } from "../gen/agentos/execution/v1/state_pb.js";
import { consoleService } from "../server/console/service.js";
import { workspaceContext } from "../server/platform/access.js";
import { partTypeKey } from "../server/read-model/decode/messages.js";
import { conversation } from "../server/read-model/views/conversation.js";
import { allCapabilities } from "../shared/permissions.js";
import { type Environment, environment, testBindings } from "./harness.js";

const workspaces: Environment[] = [];
afterEach(async () => {
  for (const env of workspaces.splice(0)) await env.close();
});

async function workspace(state = TaskState.COMPLETED) {
  const env = await environment([]);
  workspaces.push(env);
  const registry = env.executions;
  const owner = create(ExecutionIdentitySchema, {
    subject: "reader-owner",
    credential: { case: "service", value: true },
  });
  let caller = owner;
  const root = env.fake.createSession(
    { namespace: "agentos", name: "assistant" },
    randomUUID(),
    "Delete target",
  );
  const task = create(TaskSchema, {
    id: randomUUID(),
    contextId: root.id,
    history: [{ messageId: randomUUID(), role: Role.USER }],
  });
  env.fake.update(task, state);
  await registry.bind(root, owner);
  await env.reconcile.refresh();
  const client = createClient(
    ConsoleService,
    createRouterTransport(
      (router) =>
        router.service(
          ConsoleService,
          consoleService({
            ...env,
            executions: registry,
            namespace: "agentos",
            access: testBindings(env.fake),
            operations: { $typeName: "agentos.governance.v1.GovernanceConfig", environments: [] },
            roleDefaults: { modelConfig: "default-model-config", harness: "standard" },
            replaceTemplate: async (value) => env.fake.replaceTemplate(value),
            pack: create(PackSchema),
          }),
        ),
      { router: { interceptors: [workspaceContext("agentos", "assistant", async () => caller)] } },
    ),
  );
  const list = () => client.listConversations({ agent: root.agent });
  return {
    ...env,
    registry,
    owner,
    root,
    task,
    client,
    list,
    caller: (next: typeof owner) => {
      caller = next;
    },
  };
}

it("lets a read-only owner delete settled native history and closes its execution authority", async () => {
  const env = await workspace();
  expect((await env.list()).conversations[0].state).toBe(ActivityState.SUCCEEDED);
  await env.client.deleteSession({ sessionId: env.root.id });
  expect(env.fake.sessions.has(env.root.id)).toBe(false);
  expect(await env.projection.session(env.root.id)).toBeUndefined();
  expect(await env.projection.entry(env.task.id)).toBeUndefined();
  expect((await env.list()).totalSize).toBe(0);
  await env.reconcile.refresh();
  expect((await env.list()).totalSize).toBe(0);
  expect((await env.registry.record(env.root, true)).binding.revoked).toBe(true);
  await expect(
    env.client.sendMessage({
      agent: env.root.agent,
      contextId: env.root.id,
      messageId: randomUUID(),
      text: "resume",
    }),
  ).rejects.toMatchObject({ code: Code.NotFound });
});

it("denies deletion of another user's conversation even to a platform administrator", async () => {
  const env = await workspace();
  env.caller(
    create(ExecutionIdentitySchema, {
      subject: "other-admin",
      write: true,
      capabilities: allCapabilities,
      credential: { case: "service", value: true },
    }),
  );
  await expect(env.client.deleteSession({ sessionId: env.root.id })).rejects.toMatchObject({
    code: Code.NotFound,
  });
  expect(env.fake.sessions.has(env.root.id)).toBe(true);
});

it.each([
  TaskState.WORKING,
  TaskState.SUBMITTED,
  TaskState.INPUT_REQUIRED,
  TaskState.AUTH_REQUIRED,
])("preserves a conversation with unfinished native state %s", async (state) => {
  const env = await workspace(state);
  await expect(env.client.deleteSession({ sessionId: env.root.id })).rejects.toMatchObject({
    code: Code.FailedPrecondition,
  });
  expect(env.fake.task(env.task.id).status?.state).toBe(state);
  expect(env.fake.sessions.has(env.root.id)).toBe(true);
});

it("includes a background child in history status and deletion protection while the composer is available", async () => {
  const env = await workspace();
  const child = await env.fake.createChildSession(
    env.root.id,
    { namespace: "agentos", name: "knowledge" },
    "Background work",
  );
  await env.registry.bind(child, env.owner, env.root);
  const task = create(TaskSchema, { id: randomUUID(), contextId: child.id });
  env.fake.update(task, TaskState.WORKING);
  env.task.artifacts.push(
    create(ArtifactSchema, {
      artifactId: randomUUID(),
      parts: [
        {
          metadata: { [partTypeKey]: "function_call" },
          content: {
            case: "data",
            value: fromJson(ValueSchema, {
              id: "background",
              name: "dispatch_session",
              args: { session_id: child.id },
            }),
          },
        },
        {
          metadata: { [partTypeKey]: "function_response" },
          content: {
            case: "data",
            value: fromJson(ValueSchema, {
              id: "background",
              name: "dispatch_session",
              response: {
                output: toJson(
                  SendMessageResponseSchema,
                  create(SendMessageResponseSchema, { payload: { case: "task", value: task } }),
                ),
              },
            }),
          },
        },
      ],
    }),
  );
  env.fake.update(env.task, TaskState.COMPLETED);
  await env.reconcile.refresh();
  const graph = await env.projection.graphOf({ contextId: env.root.id });
  if (!graph) throw new Error("Missing conversation tree");
  expect((await conversation(graph, env.root.agent, env.root.id, async () => undefined)).busy).toBe(
    false,
  );
  expect((await env.list()).conversations[0].state).toBe(ActivityState.WORKING);
  await expect(env.client.deleteSession({ sessionId: env.root.id })).rejects.toMatchObject({
    code: Code.FailedPrecondition,
  });
  env.fake.update(task, TaskState.COMPLETED);
  await env.reconcile.refresh();
  expect((await env.list()).conversations[0].state).toBe(ActivityState.SUCCEEDED);
  await env.client.deleteSession({ sessionId: env.root.id });
});

it("rejects a new turn while the same conversation is being deleted", async () => {
  const env = await workspace();
  let release = () => {};
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = env.clients.sessions.deleteSession;
  const deletion = vi
    .spyOn(env.clients.sessions, "deleteSession")
    .mockImplementation(async (request, options) => {
      await hold;
      return original(request, options);
    });
  const pending = env.client.deleteSession({ sessionId: env.root.id });
  try {
    await vi.waitFor(() => expect(deletion).toHaveBeenCalledOnce());
    await expect(
      env.client.sendMessage({
        agent: env.root.agent,
        contextId: env.root.id,
        messageId: randomUUID(),
        text: "racing turn",
      }),
    ).rejects.toMatchObject({ code: Code.Aborted });
  } finally {
    release();
    await pending;
  }
});
