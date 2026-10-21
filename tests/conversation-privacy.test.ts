import { create } from "@bufbuild/protobuf";
import { Code, createClient, createRouterTransport } from "@connectrpc/connect";
import { expect, it } from "vitest";
import { MessageSchema, Role, TaskSchema, TaskState } from "../gen/a2a_pb.js";
import { ConsoleService } from "../gen/agentos/console/v1/console_service_pb.js";
import { ExecutionIdentitySchema } from "../gen/agentos/execution/v1/identity_pb.js";
import { SessionSchema } from "../gen/kagent/api/v1alpha1/sessions_pb.js";
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
      await expect(client.getTaskRun({ taskId: `task-${foreign.subject}` })).rejects.toMatchObject({
        code: Code.NotFound,
      });
      await expect(
        first(client.watchTask({ taskId: `task-${foreign.subject}` })),
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
