import { create } from "@bufbuild/protobuf";
import { timestampMs } from "@bufbuild/protobuf/wkt";
import { describe, expect, it } from "vitest";
import { Role, TaskSchema, TaskState } from "../gen/a2a_pb.js";
import { ConversationKind } from "../gen/agentos/console/v1/conversation_pb.js";
import { ActivityState } from "../gen/agentos/console/v1/state_pb.js";
import { DelegationKind, InteractionKind } from "../gen/agentos/console/v1/task_pb.js";
import { millis } from "../server/read-model/decode/messages.js";
import { ingest } from "../server/read-model/entry.js";
import { listConversations } from "../server/read-model/views/conversation.js";
import { engineers } from "../server/read-model/views/engineers.js";
import { listTasks, taskDetail } from "../server/read-model/views/task.js";
import { fixtureIndex, fixtureTasks, fixtureIds as ids } from "./fixtures/kagent.js";

describe("task entries", () => {
  const index = fixtureIndex();

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
      kind: DelegationKind.INVOKE,
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
  const index = fixtureIndex();

  it("projects native instance identity separately from engineer configuration and execution", async () => {
    const detail = taskDetail(index, ids.dispatchRoot);
    expect(detail).toBeDefined();
    for (const run of detail?.runs ?? []) {
      expect(run.contextId).toBe(index.entry(run.taskId)?.contextId);
      expect(detail?.sessions.find((session) => session.id === run.contextId)).toMatchObject({
        id: run.contextId,
        contextId: run.contextId,
        name: index.session(run.contextId)?.name ?? "",
        agent: { namespace: run.agentId.split("/")[0], name: run.agentId.split("/")[1] },
      });
    }
    for (const delegation of detail?.delegations ?? []) {
      expect(delegation.sourceContextId).toBe(index.entry(delegation.sourceTaskId)?.contextId);
      expect(delegation.targetContextId).toBe(index.entry(delegation.targetTaskId)?.contextId);
    }
    const { taskRun } = await import("../server/read-model/views/run.js");
    const run = await taskRun(
      {
        index,
        fullTask: async (id: string) => fixtureTasks().find((task) => task.id === id),
      } as never,
      ids.inspection,
    );
    expect(run?.contextId).toBe(index.entry(ids.inspection)?.contextId);
  });

  it("keeps the requested Session visible when the delegated Task has not arrived", () => {
    const source = fixtureTasks().find((task) => task.id === ids.dispatchRoot);
    if (!source) throw new Error("missing native task");
    const pending = fixtureIndex([source]);
    const detail = taskDetail(pending, source.id);
    const invocation = detail?.delegations.find((link) => link.kind === DelegationKind.INVOKE);
    expect(invocation?.targetTaskId).toBe("");
    expect(invocation?.targetContextId).not.toBe("");
    expect(detail?.sessions.map((session) => session.id)).toContain(invocation?.targetContextId);
    expect(
      detail?.sessions.every(
        (session) => !session.creator && !session.preparedRevision && !session.a2aAuthority,
      ),
    ).toBe(true);
  });

  it("lists operations as roots and titles chat delegations with the user's words", () => {
    const { tasks, totalSize } = listTasks(index, { query: "", pageToken: "", pageSize: 20 });
    const roots = tasks.map((task) => task.id);
    expect(roots).toEqual(
      expect.arrayContaining([ids.approvalRoot, ids.dispatchRoot, ids.chatRoot, ids.rejected]),
    );
    for (const child of [ids.approved, ids.approvalContinuation, ids.background, ids.inspection])
      expect(roots).not.toContain(child);
    expect(totalSize).toBe(tasks.length);
    expect(tasks.find((task) => task.id === ids.chatRoot)?.title).toBe("检查服务健康");
    expect(
      listTasks(index, { query: "approval-rag", pageToken: "", pageSize: 20 }).tasks.map(
        (task) => task.id,
      ),
    ).toEqual([ids.dispatchRoot]);
  });

  it("orders operations by their latest activity anywhere in the operation", () => {
    const changed = fixtureIndex();
    const child = changed.entry(ids.inspection);
    if (!child) throw new Error("missing task");
    const later = Date.now() + 60_000;
    changed.upsert({ ...child, statusAt: later, version: "later" });
    const [first] = listTasks(changed, { query: "", pageToken: "", pageSize: 1 }).tasks;
    expect(first?.updatedAt && timestampMs(first.updatedAt)).toBe(later);
    expect(taskDetail(changed, first?.id ?? "")?.runs.map((run) => run.taskId)).toContain(
      ids.inspection,
    );
  });

  it("projects the approval tree with continuations and the latest answer", () => {
    const detail = taskDetail(index, ids.approvalRoot);
    expect(detail?.summary?.state).toBe(ActivityState.SUCCEEDED);
    expect(detail?.runs.map((run) => run.taskId)).toEqual(
      expect.arrayContaining([
        ids.approvalRoot,
        ids.approved,
        ids.approvalContinuation,
        ids.question,
        ids.approvalFinal,
      ]),
    );
    expect(detail?.delegations.map((link) => link.kind)).toEqual(
      expect.arrayContaining([DelegationKind.INVOKE, DelegationKind.RESUME]),
    );
    const resume = detail?.delegations.find(
      (link) => link.targetTaskId === ids.approvalContinuation,
    );
    expect(resume).toMatchObject({
      kind: DelegationKind.RESUME,
      sourceTaskId: ids.approved,
      sourceAgentId: "agentos/remediation",
      targetAgentId: "agentos/coordinator",
    });
    expect(detail?.answer).toBe(index.entry(ids.approvalFinal)?.answer);
    expect(detail?.answer).not.toBe("");
    expect(millis(detail?.completedAt)).toBeGreaterThan(0);
  });

  it("marks dispatched knowledge as a background run", () => {
    const detail = taskDetail(index, ids.dispatchRoot);
    expect(detail?.runs.find((run) => run.taskId === ids.background)?.background).toBe(true);
    expect(detail?.runs.find((run) => run.taskId === ids.inspection)?.background).toBe(false);
    expect(detail?.delegations.find((link) => link.targetTaskId === ids.background)?.kind).toBe(
      DelegationKind.BACKGROUND,
    );
  });

  it("keeps engineers that left the namespace as observed participants", () => {
    const detail = taskDetail(index, ids.chatRoot);
    expect(detail?.participants.find((item) => item.id === "agentos/service-health")).toMatchObject(
      { name: "service-health", state: ActivityState.UNOBSERVED },
    );
  });

  it("lists engineers without system helpers", () => {
    const roles = engineers(index).map((item) => item.role);
    expect(roles).not.toContain("assistant");
    expect(roles).not.toContain("role-builder");
    expect(roles).toEqual(expect.arrayContaining(["coordinator", "inspection", "remediation"]));
  });

  it("lists conversations by kind", () => {
    const chats = listConversations(index, ConversationKind.ASSISTANT, {
      query: "",
      pageToken: "",
      pageSize: 10,
    });
    expect(chats.conversations.map((item) => item.contextId)).toEqual([ids.chatContext]);
    expect(chats.conversations[0]?.title).toBe("检查服务健康");
    expect(
      listConversations(index, ConversationKind.ROLE_BUILDER, {
        query: "",
        pageToken: "",
        pageSize: 10,
      }).totalSize,
    ).toBe(1);
  });

  it("attaches delegated operations to the chat turn", async () => {
    const { conversation } = await import("../server/read-model/views/conversation.js");
    const sync = { index, fullTask: async () => undefined } as never;
    const chat = await conversation(sync, ConversationKind.ASSISTANT, ids.chatContext);
    const [question, answer] = chat.messages;
    expect(question).toMatchObject({ role: Role.USER, taskId: ids.chat });
    expect(question?.tasks.map((task) => task.id)).toEqual([ids.chatRoot]);
    expect(answer?.role).toBe(Role.AGENT);
    expect(chat).toMatchObject({ busy: false, pending: [], ready: true });
  });
});
