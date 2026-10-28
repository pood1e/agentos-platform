import { create } from "@bufbuild/protobuf";
import { timestampMs } from "@bufbuild/protobuf/wkt";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Role, TaskSchema, TaskState } from "../gen/a2a_pb.js";
import { InteractionKind } from "../gen/agentos/console/v1/task_pb.js";
import { ActivityState } from "../gen/agentos/execution/v1/state_pb.js";
import { ingest } from "../server/read-model/entry.js";
import { taskTree } from "../server/read-model/tree.js";
import { engineer } from "../server/read-model/views/engineers.js";
import { taskRun } from "../server/read-model/views/run.js";
import { taskSummary } from "../server/read-model/views/task.js";
import { fixtureGraph, fixtureTasks, fixtureIds as ids } from "./fixtures/kagent.js";
import { environment, operator } from "./harness.js";

const fullTask = async ({ id }: { id: string }) => fixtureTasks().find((task) => task.id === id);

describe("task entries", () => {
  const index = fixtureGraph();

  it.each([false, true])("reports runtime failure with partial output=%s", (partial) => {
    const reason = "agent run failed: failed to initialize MCP session";
    const task = create(TaskSchema, {
      id: "failed-runtime",
      status: {
        state: TaskState.FAILED,
        message: { role: Role.AGENT, parts: [{ content: { case: "text", value: reason } }] },
      },
      artifacts: partial
        ? [{ parts: [{ content: { case: "text", value: "Starting the inspection" } }] }]
        : [],
    });
    expect(ingest(task, "agentos/inspection").answer).toBe(reason);
  });

  it("derives approved, rejected and answered decisions from native HITL records", () => {
    const approved = index.entry(ids.approved);
    expect(approved?.calls.find((call) => call.name === "k8s_apply_manifest")?.state).toBe(
      ActivityState.SUCCEEDED,
    );
    expect(approved?.interactions).toMatchObject([
      { kind: InteractionKind.APPROVAL, state: ActivityState.SUCCEEDED },
    ]);

    const rejected = index.entry(ids.rejected);
    expect(rejected?.calls.find((call) => call.name === "k8s_apply_manifest")?.state).toBe(
      ActivityState.REJECTED,
    );
    expect(rejected?.interactions[0]).toMatchObject({
      state: ActivityState.REJECTED,
      rejectionReason: "MVP 验证：拒绝这次测试写入，保留资源现状",
    });

    const question = index.entry(ids.question);
    expect(question?.interactions[0]).toMatchObject({
      kind: InteractionKind.QUESTION,
      state: ActivityState.SUCCEEDED,
      answers: [{ values: ["拒绝：不写入"] }],
    });
    expect(question?.calls.find((call) => call.name === "ask_user")?.state).toBe(
      ActivityState.SUCCEEDED,
    );
  });

  it("reads invoke_session results and continuation metadata", () => {
    const root = index.entry(ids.approvalRoot);
    const invoke = root?.calls.find((call) => call.name === "invoke_session");
    expect(invoke?.delegation).toMatchObject({
      kind: "invoke",
      taskId: ids.approved,
    });
    expect(invoke?.state).toBe(ActivityState.AWAITING_INPUT);
    expect(index.entry(ids.approvalContinuation)).toMatchObject({
      parentTaskId: ids.approvalRoot,
      resumedTaskId: ids.approved,
    });
  });
});

describe("views", () => {
  const index = fixtureGraph();

  it("projects the native session of runs", async () => {
    const run = await taskRun(index.entry(ids.inspection), fullTask);
    expect(run?.contextId).toBe(index.entry(ids.inspection)?.contextId);
  });

  it("projects the approval tree with continuations and the latest answer", () => {
    const tree = taskTree(index, ids.approvalRoot);
    if (!tree) throw new Error("missing operation");
    expect(taskSummary(index, tree).state).toBe(ActivityState.SUCCEEDED);
    expect(tree.entries.map((entry) => entry.id)).toEqual(
      expect.arrayContaining([
        ids.approvalRoot,
        ids.approved,
        ids.approvalContinuation,
        ids.question,
        ids.approvalFinal,
      ]),
    );
    expect(index.relations().continuations.get(ids.approvalRoot)).toContain(
      ids.approvalContinuation,
    );
    expect(tree.latest.answer).toBe(index.entry(ids.approvalFinal)?.answer);
    expect(tree.latest.answer).not.toBe("");
  });

  it("marks dispatched knowledge as a background run", () => {
    const tree = taskTree(index, ids.dispatchRoot);
    const root = index.entry(ids.dispatchRoot);
    expect(tree?.background.has(ids.background)).toBe(true);
    expect(tree?.background.has(ids.inspection)).toBe(false);
    expect(
      root?.calls.find((call) => index.target(root, call) === ids.background)?.delegation?.kind,
    ).toBe("background");
  });

  it("keeps engineers that left the namespace as observed participants", () => {
    const entries = taskTree(index, ids.chatRoot)?.entries ?? [];
    expect(
      engineer(
        index,
        "agentos/service-health",
        entries.filter((entry) => entry.agentId === "agentos/service-health"),
      ),
    ).toMatchObject({ name: "service-health", state: ActivityState.UNOBSERVED });
  });

  it("attaches delegated operations to the chat turn", async () => {
    const { conversation } = await import("../server/read-model/views/conversation.js");
    const chat = await conversation(
      index,
      { namespace: "agentos", name: "assistant" },
      ids.chatContext,
      fullTask,
    );
    const [question, answer] = chat.messages;
    expect(question).toMatchObject({ role: Role.USER, taskId: ids.chat });
    expect(question?.tasks.map((task) => task.id)).toEqual([ids.chatRoot]);
    expect(answer?.role).toBe(Role.AGENT);
    expect(chat).toMatchObject({ busy: false, interactions: [], ready: true });
  });
});

describe("listings", () => {
  const page = { query: "", pageToken: "", pageSize: 20 };
  const reader = { subject: operator.subject, administrator: false };
  let env: Awaited<ReturnType<typeof environment>>;
  beforeAll(async () => {
    env = await environment();
  });
  afterAll(() => env.close());

  it("projects the native session of operation roots", async () => {
    const root = await env.projection.entry(ids.dispatchRoot);
    const summary = (await env.projection.operations(reader, page)).tasks.find(
      (task) => task.id === ids.dispatchRoot,
    );
    expect(summary).toMatchObject({
      contextId: root?.contextId,
      agent: { namespace: root?.agentId.split("/")[0], name: root?.agentId.split("/")[1] },
    });
  });

  it("lists operations as roots and titles chat delegations with the user's words", async () => {
    const { tasks, totalSize } = await env.projection.operations(reader, page);
    const roots = tasks.map((task) => task.id);
    expect(roots).toEqual(
      expect.arrayContaining([ids.approvalRoot, ids.dispatchRoot, ids.chatRoot, ids.rejected]),
    );
    for (const child of [ids.approved, ids.approvalContinuation, ids.background, ids.inspection])
      expect(roots).not.toContain(child);
    expect(totalSize).toBe(tasks.length);
    expect(tasks.find((task) => task.id === ids.chatRoot)?.title).toBe("检查服务健康");
    expect(
      (await env.projection.operations(reader, { ...page, query: "approval-rag" })).tasks.map(
        (task) => task.id,
      ),
    ).toEqual([ids.dispatchRoot]);
  });

  it("lists engineers without system helpers", async () => {
    const { engineers } = await import("../server/read-model/views/engineers.js");
    const roles = engineers(
      await env.projection.agents(),
      await env.projection.agentActivity(reader),
    ).map((item) => item.role);
    expect(roles).not.toContain("assistant");
    expect(roles).not.toContain("role-builder");
    expect(roles).toEqual(expect.arrayContaining(["coordinator", "inspection", "remediation"]));
  });

  it("lists conversations by kind", async () => {
    const chats = await env.projection.conversations(reader, "agentos/assistant", {
      ...page,
      pageSize: 10,
    });
    expect(chats.conversations.map((item) => item.contextId)).toEqual([ids.chatContext]);
    expect(chats.conversations[0]?.title).toBe("检查服务健康");
    expect(
      (await env.projection.conversations(reader, "agentos/role-builder", page)).totalSize,
    ).toBe(1);
  });

  it("orders operations by their latest activity anywhere in the operation", async () => {
    env.fake.update(env.fake.task(ids.inspection), TaskState.FAILED);
    const child = await env.projection.entry(ids.inspection);
    const [first] = (await env.projection.operations(reader, { ...page, pageSize: 1 })).tasks;
    expect(first?.updatedAt && timestampMs(first.updatedAt)).toBe(child?.statusAt);
    const graph = await env.projection.graphOf({ taskId: first?.id ?? "" });
    expect(graph && taskTree(graph, first?.id ?? "")?.entries.map((entry) => entry.id)).toContain(
      ids.inspection,
    );
  });
});
