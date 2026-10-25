import { clone } from "@bufbuild/protobuf";
import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { Code } from "@connectrpc/connect";
import { expect, it } from "vitest";
import { TaskState } from "../gen/a2a_pb.js";
import { Capability } from "../gen/agentos/authorization/v1/permission_pb.js";
import { InteractionKind, InteractionSchema } from "../gen/agentos/console/v1/task_pb.js";
import { ActivityState } from "../gen/agentos/execution/v1/state_pb.js";
import { approvalAppReferenceKey } from "../shared/mcp-apps.js";
import { approvalAppsEnvironment as setup } from "./fixtures/approval-apps.js";

it("enriches both chat and task streams using authenticated provider lookups", async () => {
  const env = await setup();
  const controller = new AbortController();
  try {
    for await (const { conversation } of env.client.watchConversation(
      { agent: env.session.agent, contextId: env.session.id },
      { signal: controller.signal },
    )) {
      expect(conversation?.interactions[0]).toMatchObject({
        external: true,
        approve: false,
        approvals: [
          { reference: { taskId: "task", toolId: "write" }, app: { tool: "show_ticket" } },
        ],
      });
      break;
    }
    for await (const { task } of env.client.watchTask(
      { taskId: env.task.id },
      { signal: controller.signal },
    )) {
      expect(task?.interactions[0]).toMatchObject({
        external: true,
        approve: false,
        approvals: [{ id: "change" }],
      });
      break;
    }
  } finally {
    controller.abort();
  }
  expect(env.token).toHaveBeenCalledWith("lab", "catalog");
});

it("loads the declared resource and injects the host-bound approval reference into UI callbacks", async () => {
  const env = await setup();
  expect((await env.client.getAppResource({ app: env.app })).result?.value?.contents).toEqual([
    expect.objectContaining({ text: expect.stringContaining("Ticket") }),
  ]);
  await env.client.callAppTool({
    app: env.app,
    name: "decide_ticket",
    arguments: { value: { id: 19, _meta: { [approvalAppReferenceKey]: { taskId: "forged" } } } },
  });
  expect(env.calls).toHaveLength(1);
  expect(env.calls[0]).toMatchObject({
    name: "decide_ticket",
    authorization: "Bearer human-alice",
    meta: { [approvalAppReferenceKey]: { taskId: "task", toolId: "write" } },
  });
  expect(env.token).toHaveBeenCalledWith("lab", "catalog", env.owner);
});

it("isolates users and rejects forged origins, model writes and read-only approvals", async () => {
  const env = await setup();
  await expect(env.client.callAppTool({ app: env.app, name: "model_write" })).rejects.toMatchObject(
    { code: Code.PermissionDenied },
  );
  await expect(
    env.client.getAppResource({
      app: { ...env.app, origin: { case: "approvalToolId", value: "forged" } },
    }),
  ).rejects.toMatchObject({ code: Code.Unavailable });
  env.caller({ ...env.owner, write: false });
  await env.client.callAppTool({ app: env.app, name: "ticket_detail" });
  await expect(
    env.client.callAppTool({ app: env.app, name: "decide_ticket" }),
  ).rejects.toMatchObject({ code: Code.PermissionDenied });
  env.caller({ ...env.owner, subject: "bob" });
  await expect(env.client.getAppResource({ app: env.app })).rejects.toMatchObject({
    code: Code.NotFound,
  });
  expect(env.calls.map((call) => call.name)).toEqual(["ticket_detail"]);
});

it("checks native task state immediately before mutation and propagates upstream failures", async () => {
  const env = await setup();
  env.fail();
  expect(
    (await env.client.callAppTool({ app: env.app, name: "ticket_detail" })).result?.value?.isError,
  ).toBe(true);
  env.fake.update(env.task, TaskState.CANCELED);
  await expect(
    env.client.callAppTool({ app: env.app, name: "decide_ticket" }),
  ).rejects.toMatchObject({ code: Code.PermissionDenied });
  expect(env.calls).toEqual([]);
});

it("lets administrators review shared approvals with their own OBO identity while keeping chats private", async () => {
  const env = await setup();
  expect((await env.client.listApprovalRequests({})).pendingCount).toBe(1);
  env.caller({ ...env.owner, subject: "bob" });
  expect((await env.client.listApprovalRequests({})).requests).toEqual([]);
  await expect(
    env.client.listApprovals({ taskId: "task", requestId: "request" }),
  ).rejects.toMatchObject({ code: Code.NotFound });
  env.caller({ ...env.owner, subject: "bob", capabilities: [Capability.TASKS_MANAGE] });
  const queue = await env.client.listApprovalRequests({});
  expect(queue.pendingCount).toBe(1);
  expect(queue.requests[0]).toMatchObject({ taskId: "task", external: true, approve: false });
  expect(queue.requests[0]).not.toHaveProperty("messages");
  expect(
    (
      await env.client.listApprovals({
        taskId: "task",
        requestId: queue.requests[0]?.requestId,
      })
    ).approvals,
  ).toHaveLength(1);
  const watch = env.client.watchConversation({
    agent: env.session.agent,
    contextId: env.session.id,
  });
  await expect(watch[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: Code.NotFound });
  await expect(
    env.client.watchTask({ taskId: env.task.id })[Symbol.asyncIterator]().next(),
  ).rejects.toMatchObject({ code: Code.NotFound });
  await env.client.getAppResource({ app: env.app });
  await env.client.callAppTool({ app: env.app, name: "decide_ticket" });
  expect(env.calls.at(-1)?.authorization).toBe("Bearer human-bob");
  env.caller({
    ...env.owner,
    subject: "bob",
    capabilities: [Capability.TASKS_MANAGE],
    write: false,
  });
  await env.client.getAppResource({ app: env.app });
  await expect(
    env.client.callAppTool({ app: env.app, name: "decide_ticket" }),
  ).rejects.toMatchObject({ code: Code.PermissionDenied });
});

it("moves a verified decision out of the pending queue before native execution resumes", async () => {
  const env = await setup(ActivityState.SUCCEEDED);
  expect(
    await env.client.listApprovalRequests({ states: [ActivityState.AWAITING_APPROVAL] }),
  ).toMatchObject({ requests: [], pendingCount: 0, totalSize: 0 });
  const history = await env.client.listApprovalRequests({ states: [ActivityState.SUCCEEDED] });
  expect(history).toMatchObject({
    pendingCount: 0,
    totalSize: 1,
    requests: [{ taskId: "task", state: ActivityState.SUCCEEDED, approvals: [{ id: "change" }] }],
  });
  expect(env.index.entry(env.task.id)?.interactions[0]?.state).toBe(
    ActivityState.AWAITING_APPROVAL,
  );
});

it("paginates approval history without counting questions and binds cursors to the reviewer and state filter", async () => {
  const env = await setup();
  const entry = env.index.entry(env.task.id);
  const original = entry?.interactions[0];
  if (!entry || !original) throw new Error("missing approval fixture");
  const interactions = [
    ActivityState.AWAITING_APPROVAL,
    ActivityState.AWAITING_APPROVAL,
    ActivityState.REJECTED,
    ActivityState.CANCELED,
  ].map((state, index) => {
    const item = clone(InteractionSchema, original);
    item.id = `approval-${index}`;
    item.state = state;
    item.requestedAt = timestampFromMs(1000 - index);
    return item;
  });
  const question = clone(InteractionSchema, original);
  question.id = "question";
  question.kind = InteractionKind.QUESTION;
  env.index.upsert({ ...entry, interactions: [...interactions, question], version: "queue" });
  const first = await env.client.listApprovalRequests({ pageSize: 1 });
  expect(first).toMatchObject({ pendingCount: 2, totalSize: 4 });
  expect(first.requests.map((item) => item.id)).toEqual(["approval-0"]);
  const newer = clone(InteractionSchema, original);
  newer.id = "newer";
  newer.requestedAt = timestampFromMs(2000);
  env.index.upsert({ ...entry, interactions: [newer, ...interactions, question], version: "new" });
  const second = await env.client.listApprovalRequests({
    pageSize: 3,
    pageToken: first.nextPageToken,
  });
  expect(second.requests.map((item) => item.id)).toEqual([
    "approval-1",
    "approval-2",
    "approval-3",
  ]);
  expect(second).toMatchObject({ pendingCount: 3, totalSize: 5, nextPageToken: "" });
  expect(
    (
      await env.client.listApprovalRequests({
        states: [ActivityState.REJECTED, ActivityState.CANCELED],
      })
    ).totalSize,
  ).toBe(2);
  await expect(
    env.client.listApprovalRequests({
      states: [ActivityState.REJECTED],
      pageToken: first.nextPageToken,
    }),
  ).rejects.toMatchObject({ code: Code.InvalidArgument });
  env.caller({ ...env.owner, subject: "bob", capabilities: [Capability.TASKS_MANAGE] });
  await expect(
    env.client.listApprovalRequests({ pageToken: first.nextPageToken }),
  ).rejects.toMatchObject({ code: Code.InvalidArgument });
  expect(original.external).toBe(false);
});
