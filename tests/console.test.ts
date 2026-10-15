import { fileURLToPath } from "node:url";
import { clone } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient, createRouterTransport } from "@connectrpc/connect";
import { createValidateInterceptor } from "@connectrpc/validate";
import { describe, expect, it } from "vitest";
import type { Task } from "../gen/a2a_pb.js";
import { ConsoleService } from "../gen/agentos/console/v1/console_service_pb.js";
import { ConversationKind } from "../gen/agentos/console/v1/conversation_pb.js";
import { RoleDefinitionSchema } from "../gen/agentos/console/v1/role_pb.js";
import { ActivityState } from "../gen/agentos/console/v1/state_pb.js";
import { InteractionKind } from "../gen/agentos/console/v1/task_pb.js";
import { loadPack } from "../server/console/pack.js";
import { consoleService } from "../server/console/service.js";
import { pendingApprovalTasks } from "./fake-kagent/scenario.js";
import { fixtureIds as ids } from "./fixtures/kagent.js";
import { environment, testBindings } from "./harness.js";

const examplePack = fileURLToPath(new URL("fixtures/pack/", import.meta.url));

async function workbench(tasks?: Task[]) {
  const env = environment(tasks);
  await env.sync.refresh();
  const service = consoleService({
    sync: env.sync,
    clients: env.clients,
    namespace: "agentos",
    access: testBindings(env.fake),
    operations: { $typeName: "agentos.governance.v1.OperationsConfig", environments: [] },
    roleDefaults: { modelConfig: "default-model-config", harness: "standard" },
    replaceTemplate: async (template) => env.fake.replaceTemplate(template),
    pack: loadPack(examplePack),
  });
  const transport = createRouterTransport((router) => router.service(ConsoleService, service), {
    router: { interceptors: [createValidateInterceptor()] },
  });
  return { ...env, client: createClient(ConsoleService, transport) };
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
  it("serves the solution pack presentation", async () => {
    const { client } = await workbench();
    const { pack } = await client.getPack({});
    expect(pack?.title).toBe("示例方案");
    expect(pack?.roles.map((role) => role.role)).toEqual(["coordinator", "inspection"]);
    expect(pack?.roles[0]?.rig?.neck).toBe(151);
    expect(pack?.tools.map((tool) => tool.name)).toContain("NetBox");
  });

  it("keeps native approval pending and rejects direct workbench decisions", async () => {
    const { client, fake, sync } = await workbench(pendingApprovalTasks());
    expect(
      (await client.listTasks({ pageSize: 12 })).tasks.find((item) => item.id === ids.approvalRoot)
        ?.state,
    ).toBe(ActivityState.AWAITING_APPROVAL);
    const pending = sync.index
      .entry(ids.approved)
      ?.interactions.find((item) => item.kind === InteractionKind.APPROVAL);
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
    sync.close();
  });

  it("starts a conversation, deduplicates retries and streams the answer", async () => {
    const { client, fake, sync } = await workbench();
    const request = {
      kind: ConversationKind.ASSISTANT,
      messageId: "6a2f0f8e-0000-4000-8000-000000000001",
      text: "巡检 agentos-lab",
    };
    const sent = await client.sendMessage(request);
    expect(await client.sendMessage({ ...request, contextId: sent.contextId })).toEqual(sent);
    const controller = new AbortController();
    for await (const { conversation } of client.watchConversation(
      { kind: ConversationKind.ASSISTANT, contextId: sent.contextId },
      { signal: controller.signal },
    )) {
      if (conversation?.messages.some((message) => message.text === "已处理：巡检 agentos-lab"))
        break;
    }
    controller.abort();
    const { conversations } = await client.listConversations({
      kind: ConversationKind.ASSISTANT,
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
    await sync.refresh();
    expect(await rejection(client.sendMessage({ ...request, messageId: "not-ready" }))).toEqual({
      code: Code.Unavailable,
      key: "chat.notReady",
    });
    sync.close();
  });

  it("derives tool confirmation requirements when saving", async () => {
    const { client, sync } = await workbench();
    const { requirements } = await client.explainTools({ engineer: "service-health" });
    expect(requirements).toContainEqual(
      expect.objectContaining({
        server: "kagent-tool-server",
        tool: "k8s_get_resources",
        requireApproval: false,
      }),
    );
    expect(requirements.some((item) => item.server === "remediation-tools")).toBe(false);
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
    sync.close();
  });

  it("saves roles through native templates with approval and concurrency checks", async () => {
    const { client, fake, sync } = await workbench();
    const configuration = await client.getConfiguration({});
    expect(configuration.roles.map((role) => role.name)).toContain("inspection");
    const knowledge = configuration.engineerTools.find(
      (item) => item.engineer?.name === "knowledge",
    );
    expect(knowledge?.builtinTools.map((tool) => tool.name)).toEqual([
      "ask_user",
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
      tools: [
        { server: "remediation-tools", tools: ["k8s_apply_manifest"], requireApproval: false },
      ],
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
    sync.close();
  });
});
