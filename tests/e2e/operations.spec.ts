import { create, fromJson, toJson } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import { expect, test } from "@playwright/test";
import { ArtifactSchema, Role, SendMessageResponseSchema, TaskState } from "../../gen/a2a_pb.js";
import { ActivityState } from "../../gen/agentos/execution/v1/state_pb.js";
import { partTypeKey } from "../../server/read-model/decode/messages.js";
import { client, ids, observeTask, recordedTask, resetKagent, startOperation } from "./kagent.js";

test.beforeEach(async ({ request }) => resetKagent(request));

test("opens the pending approval queue and work-order drawer from the top bar", async ({
  page,
}) => {
  await page.goto("/chat");
  const pending = page.getByRole("button", { name: "待审批", exact: true });
  await expect(pending).toContainText(/[1-9]/);
  await pending.click();
  await page.getByRole("menuitem").filter({ hasText: "验证独立测试环境审批和实际处置" }).click();
  await expect(page).toHaveURL(/\/system-tasks.*task=.*approval=1/);
  const drawer = page.getByTestId("agent-drawer");
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole("button", { name: "批准并继续", exact: true })).toBeVisible();
  await expect(drawer.getByTestId("external-approvals")).toHaveCount(0);
  await page.keyboard.press("Escape");
});

test("stops a task with a completed root and a pending foreground worker", async ({ page }) => {
  await page.goto(`/system-tasks?task=${ids.approvalRoot}`);
  await page.getByRole("button", { name: "停止", exact: true }).click();
  await expect
    .poll(async () => (await client.listTasks({ query: ids.approvalRoot })).tasks[0]?.state)
    .toBe(ActivityState.CANCELED);
  await expect(page.getByRole("button", { name: "停止", exact: true })).toHaveCount(0);
  await expect
    .poll(async () =>
      (await client.listTasks({ states: [ActivityState.AWAITING_APPROVAL] })).tasks.some(
        (task) => task.id === ids.approvalRoot,
      ),
    )
    .toBe(false);
});

test("stops a delegated operation and continues in the same conversation", async ({ page }) => {
  await startOperation(page);
  await page.getByTestId("conversation").getByRole("button", { name: "停止", exact: true }).click();
  await expect(page.getByRole("button", { name: "停止", exact: true })).toHaveCount(0);
  await expect(
    page.getByTestId("approval-detail").getByRole("button", { name: "批准并继续", exact: true }),
  ).toHaveCount(0);
  const input = page.getByRole("textbox", { name: "消息", exact: true });
  await expect(input).toBeEditable();
  await expect(page.getByTestId("chat-task-panel")).toHaveCount(0);
  await expect(page.getByTestId("chat-working-agents")).toHaveCount(0);
  const conversation = new URL(page.url()).pathname;
  await input.fill("停止后继续聊");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.getByTestId("chat-message").last()).toContainText("已处理：停止后继续聊");
  expect(new URL(page.url()).pathname).toBe(conversation);
});

test("keeps a stop control for background work while allowing another message", async ({
  page,
  request,
}) => {
  await startOperation(page);
  const { profile } = await client.getAccessProfile({});
  const contextId = new URL(page.url()).pathname.split("/").at(-1) ?? "";
  let taskId = "";
  let childId = "";
  let pendingId = "";
  for await (const { conversation } of client.watchConversation({
    agent: profile?.entryAgent,
    contextId,
  })) {
    taskId = conversation?.messages.find((message) => message.role === Role.USER)?.taskId ?? "";
    childId = conversation?.runs.find((run) => run.agentId === "agentos/coordinator")?.taskId ?? "";
    pendingId =
      conversation?.runs.find((run) => run.state === ActivityState.AWAITING_APPROVAL)?.taskId ?? "";
    break;
  }
  const root = await recordedTask(request, taskId);
  const child = await recordedTask(request, childId);
  root.artifacts = [
    create(ArtifactSchema, {
      artifactId: "background-delegation",
      parts: [
        {
          metadata: { [partTypeKey]: "function_call" },
          content: {
            case: "data",
            value: fromJson(ValueSchema, {
              id: "background",
              name: "dispatch_session",
              args: { session_id: child.contextId },
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
                  create(SendMessageResponseSchema, { payload: { case: "task", value: child } }),
                ),
              },
            }),
          },
        },
      ],
    }),
  ];
  await observeTask(request, root);
  const input = page.getByRole("textbox", { name: "消息", exact: true });
  await input.fill("后台任务执行时继续输入");
  await expect(page.getByRole("button", { name: "发送", exact: true })).toBeEnabled();
  await page.getByTestId("conversation").getByRole("button", { name: "停止", exact: true }).click();
  await expect(page.getByTestId("chat-working-agents")).toHaveCount(0);
  await expect(input).toHaveValue("后台任务执行时继续输入");
  await expect
    .poll(async () => (await recordedTask(request, pendingId)).status?.state)
    .toBe(TaskState.CANCELED);
  await page.reload();
  await expect(page.getByTestId("chat-working-agents")).toHaveCount(0);
});

test("shows execution, delegation and approval intervals with working drawers", async ({
  page,
}) => {
  await page.goto(`/system-tasks?task=${ids.approvalRoot}`);
  await page.getByRole("tab", { name: "时间线", exact: true }).click();
  const timeline = page.getByTestId("task-timeline");
  await expect(timeline.getByTestId("timeline-execution")).not.toHaveCount(0);
  await expect(timeline.getByTestId("timeline-delegation")).not.toHaveCount(0);
  await expect(timeline.getByTestId("timeline-approval")).toHaveCount(1);
  await timeline.getByTestId("timeline-execution").first().click();
  await expect(page.getByTestId("agent-drawer").getByTestId("task-prompt")).toBeVisible();
  await page.keyboard.press("Escape");
  await timeline.getByTestId("timeline-approval").click();
  await expect(
    page.getByTestId("agent-drawer").getByRole("button", { name: "批准并继续", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await page.screenshot({ path: test.info().outputPath("timeline.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(timeline).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
