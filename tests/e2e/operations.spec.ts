import { expect, test } from "@playwright/test";
import { ActivityState } from "../../gen/agentos/execution/v1/state_pb.js";
import { client, ids, resetKagent, seedOperations, startOperation } from "./kagent.js";

test.beforeEach(async ({ request }) => resetKagent(request));

test("resets task pagination when filtering states and combines member filters", async ({
  page,
  request,
}) => {
  await seedOperations(request, 30);
  await page.goto("/tasks");
  const history = page.getByTestId("task-history");
  await history.getByRole("textbox").fill("巡检第");
  await expect(history.getByTestId("history-entry").first()).toContainText("巡检第 29 组");
  await history.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(history.getByTestId("history-entry").first()).not.toContainText("巡检第 29 组");
  await page.getByRole("combobox", { name: "筛选任务状态", exact: true }).click();
  await page.getByRole("option", { name: "已完成", exact: true }).click();
  await expect(history.getByTestId("history-entry").first()).toContainText("巡检第 29 组");
  await history.getByRole("textbox").fill("");
  await page.getByRole("combobox", { name: "筛选任务状态", exact: true }).click();
  await page.getByRole("option", { name: "等待审批", exact: true }).click();
  await page.getByRole("combobox", { name: "筛选任务成员", exact: true }).click();
  await page.getByRole("option", { name: "处置工程师", exact: true }).click();
  await expect(history.getByTestId("history-entry")).not.toHaveCount(0);
  await expect(page).toHaveURL(/state=AWAITING_APPROVAL.*engineer=agentos%2Fremediation/);
  await page.getByRole("combobox", { name: "筛选任务成员", exact: true }).click();
  await page.getByRole("option", { name: "巡检工程师", exact: true }).click();
  await expect(history.getByTestId("history-entry")).toHaveCount(0);
});

test("opens the pending approval queue and work-order drawer from the top bar", async ({
  page,
}) => {
  await page.goto("/tasks");
  await page.getByTestId("task-history").getByRole("textbox").fill("没有这种任务");
  const pending = page.getByRole("link", { name: "待审批", exact: true });
  await expect(pending).toContainText(/[1-9]/);
  await pending.click();
  await expect(page).toHaveURL(/state=AWAITING_APPROVAL&approval=1/);
  const drawer = page.getByTestId("agent-drawer");
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole("button", { name: "批准并继续", exact: true })).toBeVisible();
  await expect(drawer.getByTestId("external-approvals")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("combobox", { name: "筛选任务状态", exact: true })).toContainText(
    "等待审批",
  );
});

test("stops a task with a completed root and a pending foreground worker", async ({ page }) => {
  await page.goto(`/tasks/${ids.approvalRoot}`);
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

test("stops a delegated operation from the chat composer", async ({ page }) => {
  await startOperation(page);
  await page.getByRole("button", { name: "停止", exact: true }).click();
  await expect(page.getByRole("button", { name: "停止", exact: true })).toHaveCount(0);
  await expect(page.getByTestId("approval-detail")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "发送", exact: true })).toBeVisible();
  await page.getByTestId("chat-task").click();
  await expect(page.getByTestId("task-title")).toBeVisible();
  await expect(page.getByText("已取消", { exact: true })).toBeVisible();
});

test("shows execution, delegation and approval intervals with working drawers", async ({
  page,
}) => {
  await page.goto(`/tasks/${ids.approvalRoot}`);
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
