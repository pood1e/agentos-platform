import { create } from "@bufbuild/protobuf";
import { Code, createClient, createRouterTransport } from "@connectrpc/connect";
import { createValidateInterceptor } from "@connectrpc/validate";
import { expect, it } from "vitest";
import { Role, TaskSchema, TaskState } from "../gen/a2a_pb.js";
import { Capability } from "../gen/agentos/authorization/v1/permission_pb.js";
import { ConsoleService } from "../gen/agentos/console/v1/console_service_pb.js";
import { PackSchema } from "../gen/agentos/console/v1/pack_pb.js";
import { ExecutionIdentitySchema } from "../gen/agentos/execution/v1/identity_pb.js";
import { SessionSchema } from "../gen/kagent/api/v1/sessions_pb.js";
import { consoleService } from "../server/console/service.js";
import { workspaceContext } from "../server/platform/access.js";
import { allCapabilities } from "../shared/permissions.js";
import { fixtureIds } from "./fixtures/kagent.js";
import { environment, operator, testBindings } from "./harness.js";

async function taggedWorkspace() {
  const env = await environment([]);
  const registry = env.executions;
  const alice = create(ExecutionIdentitySchema, {
    subject: "alice",
    credential: { case: "service", value: true },
  });
  const bob = create(ExecutionIdentitySchema, {
    subject: "bob",
    write: true,
    capabilities: allCapabilities,
    credential: { case: "service", value: true },
  });
  const serviceExecution = create(ExecutionIdentitySchema, {
    subject: "service:execution:example",
    write: true,
    credential: { case: "service", value: true },
  });
  const owners = [alice, bob, serviceExecution];
  const sessions = owners.map((owner) =>
    create(SessionSchema, {
      id: owner.subject,
      agent: { namespace: "agentos", name: "inspection" },
    }),
  );
  const tasks = sessions.map((session) =>
    create(TaskSchema, {
      id: `task-${session.id}`,
      contextId: session.id,
      status: { state: TaskState.WORKING },
      history: [
        {
          role: Role.USER,
          messageId: session.id,
          parts: [{ content: { case: "text", value: session.id } }],
        },
      ],
    }),
  );
  env.fake.load({ sessions, tasks });
  for (const [position, owner] of owners.entries()) await registry.bind(sessions[position], owner);
  await registry.revoke(sessions[0], alice);
  await env.reconcile.refresh();
  let caller = alice;
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
      {
        router: {
          interceptors: [
            workspaceContext("agentos", "assistant", async () => caller),
            createValidateInterceptor(),
          ],
        },
      },
    ),
  );
  const agent = { namespace: "agentos", name: "inspection" };
  async function shared(contextId: string) {
    for await (const response of client.watchConversation({ agent, contextId }))
      return response.conversation;
  }
  return {
    ...env,
    agent,
    alice,
    bob,
    client,
    shared,
    caller: (value: typeof alice) => {
      caller = value;
    },
  };
}

it("lets read-only owners tag revoked executions while keeping personal metadata private even from administrators", async () => {
  const env = await taggedWorkspace();
  const { client, alice, bob } = env;
  const native = structuredClone([...env.fake.tasks]);
  try {
    const saved = await client.updateTaskTags({
      taskId: "task-alice",
      tags: ["private-analysis"],
      tagsVersion: "0",
    });
    expect(saved.task).toMatchObject({ tags: ["private-analysis"], tagsVersion: "1" });
    env.caller(bob);
    expect((await client.listTasks({})).availableTags).toEqual([]);
    expect((await client.listTasks({ tags: ["private-analysis"] })).totalSize).toBe(0);
    await expect(
      client.updateTaskTags({ taskId: "task-alice", tags: [], tagsVersion: "1" }),
    ).rejects.toMatchObject({ code: Code.NotFound });
    expect((await client.listTasks({ query: "task-alice" })).totalSize).toBe(0);
    env.caller(alice);
    expect(
      (await client.listTasks({ query: "private-analysis" })).tasks.map((task) => task.id),
    ).toEqual(["task-alice"]);
    expect([...env.fake.tasks]).toEqual(native);
  } finally {
    await env.close();
  }
});

it("requires the dedicated capability for shared task tags and streams their changes", async () => {
  const env = await taggedWorkspace();
  const { client, shared, agent, alice } = env;
  const session = "service:execution:example";
  const id = `task-${session}`;
  try {
    await expect(shared(session)).rejects.toMatchObject({ code: Code.NotFound });
    alice.capabilities = [Capability.AGENTS_MANAGE];
    expect((await shared(session))?.messages[0]?.tasks[0]?.id).toBe(id);
    await expect(
      client.updateTaskTags({ taskId: id, tags: ["analysis"], tagsVersion: "0" }),
    ).rejects.toMatchObject({ code: Code.PermissionDenied });
    alice.capabilities = [Capability.TASKS_MANAGE];
    const events = client.watchConversation({ agent, contextId: session })[Symbol.asyncIterator]();
    try {
      await events.next();
      await client.updateTaskTags({ taskId: id, tags: ["analysis", "维护"], tagsVersion: "0" });
      expect((await events.next()).value?.conversation?.messages[0]?.tasks[0]?.tags).toEqual([
        "analysis",
        "维护",
      ]);
    } finally {
      await events.return?.();
    }
    expect((await client.listTasks({ tags: ["analysis", "维护"] })).totalSize).toBe(1);
    expect((await client.listTasks({ tags: ["analysis", "absent"] })).totalSize).toBe(0);
    alice.capabilities = [];
    await expect(shared(session)).rejects.toMatchObject({ code: Code.NotFound });
    await expect(
      client.updateTaskTags({ taskId: id, tags: [], tagsVersion: "1" }),
    ).rejects.toMatchObject({ code: Code.NotFound });
  } finally {
    await env.close();
  }
});

it("preserves concurrent edits and rejects malformed tags and missing version tokens", async () => {
  const env = await taggedWorkspace();
  try {
    const first = { taskId: "task-alice", tags: ["cafe\u0301"], tagsVersion: "0" };
    expect((await env.client.updateTaskTags(first)).task?.tags).toEqual(["café"]);
    await expect(env.client.updateTaskTags(first)).rejects.toMatchObject({ code: Code.Aborted });
    await env.client.updateTaskTags({ ...first, tags: [], tagsVersion: "1" });
    await expect(env.client.updateTaskTags(first)).rejects.toMatchObject({ code: Code.Aborted });
    for (const tags of [
      [""],
      [" a "],
      ["a\nb"],
      ["a\tb"],
      ["a".repeat(41)],
      ["same", "same"],
      Array.from({ length: 33 }, (_, i) => `tag-${i}`),
    ])
      await expect(
        env.client.updateTaskTags({ ...first, tags, tagsVersion: "2" }),
      ).rejects.toMatchObject({ code: Code.InvalidArgument });
    await expect(env.client.updateTaskTags({ ...first, tagsVersion: "" })).rejects.toMatchObject({
      code: Code.InvalidArgument,
    });
  } finally {
    await env.close();
  }
});

it("stores child task edits on the operation root without changing runtime task versions", async () => {
  const env = await environment();
  await env.reconcile.refresh();
  const { taskTagCommands } = await import("../server/console/task-tags.js");
  const command = taskTagCommands(env.clients, env.tags, env.executions);
  try {
    const result = await command.update(
      create(ConsoleService.method.updateTaskTags.input, {
        taskId: fixtureIds.approved,
        tags: ["maintenance"],
        tagsVersion: "0",
      }),
      await env.projection.graphOf({ taskId: fixtureIds.approved }),
      operator,
    );
    expect(result.task.id).toBe(fixtureIds.approvalRoot);
    expect((await env.tags.read([fixtureIds.approved, fixtureIds.approvalRoot])).size).toBe(1);
  } finally {
    await env.close();
  }
});
