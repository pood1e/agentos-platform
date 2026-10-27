import { fileURLToPath } from "node:url";
import { clone, create } from "@bufbuild/protobuf";
import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError } from "@connectrpc/connect";
import { describe, expect, it } from "vitest";
import { Role, type Task, TaskSchema, TaskState } from "../gen/a2a_pb.js";
import { RoleDefinitionSchema } from "../gen/agentos/console/v1/role_pb.js";
import { InteractionKind } from "../gen/agentos/console/v1/task_pb.js";
import { ActivityState } from "../gen/agentos/execution/v1/state_pb.js";
import { SessionSchema } from "../gen/kagent/api/v1/sessions_pb.js";
import { loadPack } from "../server/console/pack.js";
import { pendingApprovalTasks } from "./fake-kagent/scenario.js";
import { fixtureIds as ids } from "./fixtures/kagent.js";
import { bindTasks, consoleClient, environment } from "./harness.js";

const examplePack = fileURLToPath(new URL("fixtures/pack/", import.meta.url));

async function workbench(tasks?: Task[]) {
  const env = await environment(tasks);
  await env.reconcile.refresh();
  return { ...env, client: consoleClient(env, { pack: loadPack(examplePack) }) };
}

async function rejection(call: Promise<unknown>) {
  const error = await call.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  if (!(error instanceof ConnectError)) throw new Error("expected a ConnectError");
  return { code: error.code, key: error.rawMessage };
}

describe("console service", () => {
  it("cancels an operation through a child task and closes its pending approval interval", async () => {
    const { client, projection, fake, close } = await workbench(pendingApprovalTasks());
    try {
      await client.cancelTask({ taskId: ids.approved });
      expect(fake.task(ids.approved).status?.state).toBe(TaskState.CANCELED);
      expect(fake.task(ids.approvalRoot).status?.state).toBe(TaskState.COMPLETED);
      expect(
        (await client.listTasks({ states: [ActivityState.AWAITING_APPROVAL] })).totalSize,
      ).toBe(0);
      expect((await client.listTasks({ query: ids.approvalRoot })).tasks[0]?.state).toBe(
        ActivityState.CANCELED,
      );
      const approval = (await projection.entry(ids.approved))?.interactions[0];
      expect(approval?.state).toBe(ActivityState.CANCELED);
      expect(approval?.requestedAt).toBeDefined();
      expect(approval?.answeredAt).toBeDefined();
      await expect(client.cancelTask({ taskId: "missing" })).rejects.toMatchObject({
        code: Code.NotFound,
      });
    } finally {
      await close();
    }
  });
  it("serves the solution pack presentation", async () => {
    const { client } = await workbench();
    const { pack } = await client.getPack({});
    expect(pack?.title).toBe("示例方案");
    expect(pack?.roles.map((role) => role.role)).toEqual(["coordinator", "inspection"]);
    expect(pack?.roles[0]?.rig?.neck).toBe(151);
    expect(pack?.tools.map((tool) => tool.name)).toContain("NetBox");
  });

  it("keeps native approval pending and rejects direct workbench decisions", async () => {
    const { client, fake, projection, close } = await workbench(pendingApprovalTasks());
    expect(
      (await client.listTasks({ pageSize: 12 })).tasks.find((item) => item.id === ids.approvalRoot)
        ?.state,
    ).toBe(ActivityState.AWAITING_APPROVAL);
    const pending = (await projection.entry(ids.approved))?.interactions.find(
      (item) => item.kind === InteractionKind.APPROVAL,
    );
    if (!pending) throw new Error("native approval missing");
    expect(
      await rejection(
        client.respondInteraction({
          taskId: ids.approved,
          requestId: pending.requestId,
          decision: { case: "answer", value: { answers: [{ values: ["yes"] }] } },
        }),
      ),
    ).toMatchObject({ code: Code.InvalidArgument, key: "interaction.invalidAnswer" });
    expect(fake.received).toHaveLength(0);
    await close();
  });

  it("starts a conversation, deduplicates retries and streams the answer", async () => {
    const { client, fake, reconcile, close } = await workbench();
    const request = {
      agent: { namespace: "agentos", name: "assistant" },
      messageId: "6a2f0f8e-0000-4000-8000-000000000001",
      text: "巡检 agentos-lab",
    };
    const sent = await client.sendMessage(request);
    expect(await client.sendMessage({ ...request, contextId: sent.contextId })).toEqual(sent);
    const controller = new AbortController();
    for await (const { conversation } of client.watchConversation(
      { agent: { namespace: "agentos", name: "assistant" }, contextId: sent.contextId },
      { signal: controller.signal },
    )) {
      if (
        conversation?.messages.some((message) =>
          message.parts.some(
            (part) =>
              part.content.case === "text" && part.content.value === "已处理：巡检 agentos-lab",
          ),
        )
      )
        break;
    }
    controller.abort();
    const { conversations } = await client.listConversations({
      agent: { namespace: "agentos", name: "assistant" },
      pageSize: 12,
    });
    expect(conversations[0]).toMatchObject({
      contextId: sent.contextId,
      title: "巡检 agentos-lab",
    });
    expect(
      await rejection(client.sendMessage({ ...request, messageId: "other", text: "" })),
    ).toMatchObject({ code: Code.InvalidArgument });
    const assistant = fake.agents.find((agent) => agent.ref?.name === "assistant")?.resource;
    if (!assistant?.value) throw new Error("missing assistant");
    assistant.value.status = { conditions: [{ type: "Ready", status: "False" }] };
    await reconcile.refresh();
    expect(await rejection(client.sendMessage({ ...request, messageId: "not-ready" }))).toEqual({
      code: Code.Unavailable,
      key: "chat.notReady",
    });
    await close();
  });

  it("loads a newly observed conversation before deciding that it is unavailable", async () => {
    const { client, fake, store, projection, close } = await workbench([]);
    const agent = { namespace: "agentos", name: "assistant" };
    const session = create(SessionSchema, { id: "newly-observed", agent });
    const task = create(TaskSchema, {
      id: "new-task",
      contextId: session.id,
      status: { state: TaskState.COMPLETED, timestamp: timestampFromMs(Date.now()) },
      history: [{ messageId: "new-message", role: Role.USER }],
      artifacts: [{ parts: [{ content: { case: "text", value: "同步后的回答" } }] }],
    });
    fake.load({ sessions: [session], tasks: [task] });
    await bindTasks(store, fake, [task]);
    expect(await projection.session(session.id)).toBeUndefined();
    const controller = new AbortController();
    try {
      for await (const { conversation } of client.watchConversation(
        { agent, contextId: session.id },
        { signal: controller.signal },
      )) {
        expect(conversation?.contextId).toBe(session.id);
        expect(conversation?.messages.flatMap((message) => message.parts)).toContainEqual(
          expect.objectContaining({ content: { case: "text", value: "同步后的回答" } }),
        );
        break;
      }
    } finally {
      controller.abort();
      await close();
    }
  });

  it("derives tool confirmation requirements when saving", async () => {
    const { client, close } = await workbench();
    const { requirements } = await client.explainTools({ engineer: "service-health" });
    expect(requirements).toContainEqual(
      expect.objectContaining({
        server: "kagent-tool-server",
        tool: "k8s_get_resources",
        requireApproval: false,
      }),
    );
    expect(requirements.find((item) => item.server === "remediation-tools")?.requireApproval).toBe(
      true,
    );
    const created = await client.createRole({
      role: {
        name: "service-health",
        displayName: "服务健康工程师",
        systemPrompt: "Inspect services read-only.",
        tools: [
          { server: "kagent-tool-server", tools: ["k8s_get_resources"], requireApproval: true },
        ],
      },
    });
    expect(created.role?.tools).toEqual([
      expect.objectContaining({
        server: "kagent-tool-server",
        tools: ["k8s_get_resources"],
        requireApproval: false,
      }),
    ]);
    await close();
  });

  it("saves roles through native templates with approval and concurrency checks", async () => {
    const { client, fake, close } = await workbench();
    const configuration = await client.getConfiguration({});
    expect(configuration.roles.map((role) => role.name)).toContain("inspection");
    const knowledge = configuration.engineerTools.find(
      (item) => item.engineer?.name === "knowledge",
    );
    expect(knowledge?.builtinTools.map((tool) => tool.name)).toEqual([
      "ask_user",
      "read_file",
      "write_file",
      "edit_file",
      "bash",
      "list_files",
      "grep_file",
      "save_memory",
      "load_memory",
      "preload_memory",
    ]);
    expect(configuration.roles.find((role) => role.name === "knowledge")?.tools).toEqual([]);
    const role = {
      name: "service-health",
      displayName: "服务健康工程师",
      description: "Checks services",
      systemPrompt: "Inspect services read-only.",
      tools: [{ server: "remediation-tools", tools: ["unknown_tool"], requireApproval: false }],
    };
    expect(await rejection(client.createRole({ role }))).toEqual({
      code: Code.InvalidArgument,
      key: "configuration.invalidTools",
    });
    const created = await client.createRole({
      role: {
        ...role,
        tools: [
          { server: "kagent-tool-server", tools: ["k8s_get_resources"], requireApproval: false },
        ],
      },
    });
    expect(created.role?.resourceVersion).toBe("1");
    expect(fake.agents.some((agent) => agent.ref?.name === "service-health")).toBe(true);
    if (!created.role) throw new Error("role not returned");
    const update = clone(RoleDefinitionSchema, created.role);
    update.description = "Checks services and endpoints";
    const stale = clone(RoleDefinitionSchema, update);
    stale.resourceVersion = "0";
    expect(await rejection(client.updateRole({ role: stale }))).toEqual({
      code: Code.Aborted,
      key: "configuration.conflict",
    });
    const updated = await client.updateRole({ role: update });
    expect(updated.role).toMatchObject({
      description: "Checks services and endpoints",
      displayName: "服务健康工程师",
      resourceVersion: "2",
    });
    await close();
  });
});
