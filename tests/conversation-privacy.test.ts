import { create } from "@bufbuild/protobuf";
import { Code, createClient, createRouterTransport } from "@connectrpc/connect";
import { expect, it } from "vitest";
import { MessageSchema, Role, TaskSchema, TaskState } from "../gen/a2a_pb.js";
import { Capability } from "../gen/agentos/authorization/v1/permission_pb.js";
import { ConsoleService } from "../gen/agentos/console/v1/console_service_pb.js";
import { ExecutionIdentitySchema } from "../gen/agentos/execution/v1/identity_pb.js";
import { SessionSchema } from "../gen/kagent/api/v1/sessions_pb.js";
import { executions } from "../server/authorization/executions.js";
import { loadPack } from "../server/console/pack.js";
import { consoleService } from "../server/console/service.js";
import { workspaceContext } from "../server/platform/access.js";
import { memoryStore } from "./fixtures/execution-store.js";
import { environment, testBindings } from "./harness.js";

const identity = (subject: string, write = false) =>
  create(ExecutionIdentitySchema, { subject, write, credential: { case: "service", value: true } });

it("isolates conversation search, counts, task payloads, approvals and streams for every user including writers", async () => {
  const env = environment([]);
  const registry = executions(memoryStore());
  const alice = identity("user:alice"),
    bob = identity("user:bob", true);
  const identities = [alice, bob];
  const sessions = [alice, bob, identity("legacy")].map((owner) =>
    create(SessionSchema, {
      id: owner.subject,
      agent: { namespace: "agentos", name: "assistant" },
      name: `${owner.subject} private conversation`,
    }),
  );
  const tasks = sessions.map((session) =>
    create(TaskSchema, {
      id: `task-${session.id}`,
      contextId: session.id,
      status: { state: TaskState.COMPLETED },
      history: [
        create(MessageSchema, {
          messageId: `message-${session.id}`,
          role: Role.USER,
          parts: [{ content: { case: "text", value: `${session.id} private message` } }],
        }),
      ],
    }),
  );
  const operations = identities.map((owner) =>
    create(SessionSchema, {
      id: `${owner.subject}-operation`,
      name: `${owner.subject} private operation`,
      agent: { namespace: "agentos", name: "inspection" },
    }),
  );
  sessions.push(...operations);
  tasks.push(
    ...operations.map((session) =>
      create(TaskSchema, {
        id: `task-${session.id}`,
        contextId: session.id,
        status: { state: TaskState.COMPLETED },
        history: [
          create(MessageSchema, {
            messageId: `message-${session.id}`,
            role: Role.USER,
            parts: [
              { content: { case: "text", value: `${session.id} private operation content` } },
            ],
          }),
        ],
      }),
    ),
  );
  env.fake.load({ sessions, tasks });
  await env.sync.refresh();
  for (const [position, owner] of identities.entries())
    await registry.bind(sessions[position], owner);
  for (const [position, owner] of identities.entries())
    await registry.bind(operations[position], owner, sessions[position]);
  await registry.revoke(sessions[0], alice);
  let caller = alice;
  const client = createClient(
    ConsoleService,
    createRouterTransport(
      (router) =>
        router.service(
          ConsoleService,
          consoleService({
            ...env,
            namespace: "agentos",
            access: testBindings(env.fake),
            executions: registry,
            operations: { $typeName: "agentos.governance.v1.GovernanceConfig", environments: [] },
            roleDefaults: { modelConfig: "default-model-config", harness: "standard" },
            replaceTemplate: async (t) => env.fake.replaceTemplate(t),
            pack: loadPack(),
          }),
        ),
      { router: { interceptors: [workspaceContext("agentos", "assistant", async () => caller)] } },
    ),
  );
  const agent = { namespace: "agentos", name: "assistant" };
  async function first(stream: AsyncIterable<unknown>) {
    for await (const value of stream) return value;
  }
  try {
    for (const owner of identities) {
      caller = owner;
      const foreign = identities.find((value) => value.subject !== owner.subject);
      if (!foreign) throw new Error("Fixture user missing");
      const list = await client.listConversations({ agent, pageSize: 1 });
      expect(list.totalSize).toBe(1);
      const operations = await client.listTasks({});
      await expect(client.listTasks({ systemOnly: true })).rejects.toMatchObject({
        code: Code.PermissionDenied,
      });
      expect(operations.totalSize).toBe(1);
      expect(operations.tasks[0]?.id).toBe(`task-${owner.subject}-operation`);
      expect((await client.listTasks({ query: foreign.subject })).totalSize).toBe(0);
      expect(list.conversations[0]?.contextId).toBe(owner.subject);
      expect((await client.listConversations({ agent, query: foreign.subject })).totalSize).toBe(0);
      await expect(
        first(client.watchConversation({ agent, contextId: owner.subject })),
      ).resolves.toMatchObject({ conversation: { contextId: owner.subject } });
      await expect(
        first(client.watchConversation({ agent, contextId: foreign.subject })),
      ).rejects.toMatchObject({ code: Code.NotFound });
      await expect(
        first(client.watchConversation({ agent, contextId: "legacy" })),
      ).rejects.toMatchObject({ code: Code.NotFound });
      await expect(
        first(
          client.watchConversation({
            agent: { namespace: "agentos", name: "inspection" },
            contextId: `${owner.subject}-operation`,
          }),
        ),
      ).rejects.toMatchObject({ code: Code.NotFound });
      await expect(
        client.listApprovals({ taskId: `task-${foreign.subject}`, requestId: "probe" }),
      ).rejects.toMatchObject({ code: Code.NotFound });
      await expect(client.cancelTask({ taskId: `task-${foreign.subject}` })).rejects.toMatchObject({
        code: Code.NotFound,
      });
    }
    await expect(
      client.sendMessage({
        agent: { namespace: "agentos", name: "inspection" },
        messageId: "bypass",
        text: "query",
      }),
    ).rejects.toMatchObject({ code: Code.NotFound });
    expect(env.fake.sessions.size).toBe(5);
  } finally {
    env.sync.close();
  }
});

it("interrupts a foreground run while preserving the owner's conversation and tool scope", async () => {
  const env = environment([]);
  const registry = executions(memoryStore());
  const owner = identity("user:voice-caller");
  const agent = { namespace: "agentos", name: "assistant" };
  const session = create(SessionSchema, { id: "voice-context", agent });
  const task = create(TaskSchema, {
    id: "voice-task",
    contextId: session.id,
    status: { state: TaskState.WORKING },
    history: [{ messageId: "voice-message", role: Role.USER }],
  });
  env.fake.load({ sessions: [session], tasks: [task] });
  await registry.bind(session, owner);
  await env.sync.refresh();
  const client = createClient(
    ConsoleService,
    createRouterTransport(
      (router) =>
        router.service(
          ConsoleService,
          consoleService({
            ...env,
            namespace: "agentos",
            access: testBindings(env.fake),
            executions: registry,
            operations: { $typeName: "agentos.governance.v1.GovernanceConfig", environments: [] },
            roleDefaults: { modelConfig: "default-model-config", harness: "standard" },
            replaceTemplate: async (value) => env.fake.replaceTemplate(value),
            pack: loadPack(),
          }),
        ),
      { router: { interceptors: [workspaceContext("agentos", "assistant", async () => owner)] } },
    ),
  );
  try {
    await client.cancelTask({ taskId: task.id });
    expect(env.fake.task(task.id).status?.state).toBe(TaskState.CANCELED);
    const authorized = await registry.resolve(session);
    expect(authorized.binding.revoked).toBe(false);
    expect(authorized.binding.subject).toBe(owner.subject);
    expect(authorized.write).toBe(false);
    const next = await client.sendMessage({
      agent,
      contextId: session.id,
      messageId: "next-voice-turn",
      text: "你好",
    });
    expect(next.contextId).toBe(session.id);
    expect(next.taskId).not.toBe(task.id);
  } finally {
    env.sync.close();
  }
});

it("lets administrators read shared service sessions of workspace agents without operating them", async () => {
  const env = environment([]);
  const registry = executions(memoryStore());
  const user = identity("user:alice");
  const administrator = create(ExecutionIdentitySchema, {
    subject: "user:administrator",
    capabilities: [Capability.TASKS_MANAGE],
    credential: { case: "service", value: true },
  });
  const agent = { namespace: "agentos", name: "inspection" };
  const shared = create(SessionSchema, { id: "shared-run", agent, name: "Nightly inspection" });
  const personal = create(SessionSchema, { id: "personal-run", agent, name: "Own inspection" });
  env.fake.load({
    sessions: [shared, personal],
    tasks: [shared, personal].map((session) =>
      create(TaskSchema, {
        id: `task-${session.id}`,
        contextId: session.id,
        status: { state: TaskState.COMPLETED },
        history: [
          create(MessageSchema, {
            messageId: `message-${session.id}`,
            role: Role.USER,
            parts: [{ content: { case: "text", value: "Inspect the cluster" } }],
          }),
        ],
      }),
    ),
  });
  await env.sync.refresh();
  await registry.bind(shared, identity("service:scheduler"));
  await registry.bind(personal, user);
  let caller = administrator;
  const client = createClient(
    ConsoleService,
    createRouterTransport(
      (router) =>
        router.service(
          ConsoleService,
          consoleService({
            ...env,
            namespace: "agentos",
            access: testBindings(env.fake),
            executions: registry,
            operations: { $typeName: "agentos.governance.v1.GovernanceConfig", environments: [] },
            roleDefaults: { modelConfig: "default-model-config", harness: "standard" },
            replaceTemplate: async (value) => env.fake.replaceTemplate(value),
            pack: loadPack(),
          }),
        ),
      { router: { interceptors: [workspaceContext("agentos", "assistant", async () => caller)] } },
    ),
  );
  async function first(stream: AsyncIterable<unknown>) {
    for await (const value of stream) return value;
  }
  try {
    await expect(
      first(client.watchConversation({ agent, contextId: shared.id })),
    ).resolves.toMatchObject({
      conversation: {
        contextId: shared.id,
        operate: false,
        messages: [
          {
            tasks: [{ id: "task-shared-run", contextId: shared.id, agent: { name: "inspection" } }],
          },
        ],
      },
    });
    for (const contextId of [personal.id, ""])
      await expect(first(client.watchConversation({ agent, contextId }))).rejects.toMatchObject({
        code: Code.NotFound,
      });
    await expect(
      client.sendMessage({ agent, contextId: shared.id, messageId: "write", text: "Continue" }),
    ).rejects.toMatchObject({ code: Code.NotFound });
    caller = user;
    await expect(
      first(client.watchConversation({ agent, contextId: shared.id })),
    ).rejects.toMatchObject({ code: Code.NotFound });
  } finally {
    env.sync.close();
  }
});
