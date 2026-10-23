import { expect, test } from "@playwright/test";
import { ActivityState } from "../../gen/agentos/execution/v1/state_pb.js";
import { client, ids, resetKagent, startOperation } from "./kagent.js";

test.beforeEach(async ({ request }) => resetKagent(request));

test("opens the pending approval queue and work-order drawer from the top bar", async ({
  page,
}) => {
  await page.goto("/chat");
  const pending = page.getByRole("button", { name: "待审批", exact: true });
  await expect(pending).toContainText(/[1-9]/);
  await pending.click();
  await page.getByRole("menuitem").filter({ hasText: "验证独立测试环境审批和实际处置" }).click();
  await expect(page).toHaveURL(/\/chat.*task=.*approval=1/);
  const drawer = page.getByTestId("agent-drawer");
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole("button", { name: "批准并继续", exact: true })).toBeVisible();
  await expect(drawer.getByTestId("external-approvals")).toHaveCount(0);
  await page.keyboard.press("Escape");
});

test("stops a task with a completed root and a pending foreground worker", async ({ page }) => {
  await page.goto(`/chat?task=${ids.approvalRoot}`);
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
  await expect(page.getByTestId("approval-detail")).toHaveCount(0);
  const input = page.getByRole("textbox", { name: "消息", exact: true });
  await expect(input).toBeEditable();
  await page.getByTestId("chat-task").click();
  await expect(page.getByTestId("task-title")).toBeVisible();
  await expect(
    page.getByTestId("chat-task-panel").getByText("已取消", { exact: true }).first(),
  ).toBeVisible();
  const conversation = new URL(page.url()).pathname;
  await input.fill("停止后继续聊");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.getByTestId("chat-message").last()).toContainText("已处理：停止后继续聊");
  expect(new URL(page.url()).pathname).toBe(conversation);
});

test("shows execution, delegation and approval intervals with working drawers", async ({
  page,
}) => {
  await page.goto(`/chat?task=${ids.approvalRoot}`);
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
