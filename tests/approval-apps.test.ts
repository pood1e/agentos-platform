import { Code } from "@connectrpc/connect";
import { expect, it } from "vitest";
import { TaskState } from "../gen/a2a_pb.js";
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
