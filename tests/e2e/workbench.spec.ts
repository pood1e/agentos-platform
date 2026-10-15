import { expect, test } from "@playwright/test";
import { ActivityState } from "../../gen/agentos/console/v1/state_pb.js";
import { client, decideWorkOrder, resetKagent, startOperation, workOrders } from "./kagent.js";

test.beforeEach(async ({ request }) => resetKagent(request));

test("completes chat delegation, approval, worker continuation and background knowledge", async ({
  page,
  request,
}) => {
  await workOrders(page);
  await startOperation(page);
  await page.getByTestId("chat-task").click();
  await expect(page).toHaveURL(/\/tasks\/[^/]+$/);
  const id = new URL(page.url()).pathname.split("/").at(-1) ?? "";
  await expect(page.getByTestId("approval-node")).toBeVisible();
  await page.getByRole("button", { name: "等待审批", exact: true }).click();
  const drawer = page.getByTestId("agent-drawer");
  await expect(drawer.getByTestId("approval-arguments")).toContainText("approval-smoke");
  await expect(drawer.getByRole("button", { name: "批准并执行", exact: true })).toHaveCount(0);
  await decideWorkOrder(page, request, true);
  await expect
    .poll(async () => (await client.listTasks({ query: id })).tasks[0]?.state, { timeout: 20_000 })
    .toBe(ActivityState.SUCCEEDED);
  await page.keyboard.press("Escape");
  await expect(
    page.getByText("用户决定已处理，执行结果已核验；知识正在后台沉淀。", { exact: true }),
  ).toBeVisible();
  await expect
    .poll(async () => {
      const controller = new AbortController();
      try {
        for await (const { task } of client.watchTask(
          { taskId: id },
          { signal: controller.signal },
        ))
          return task?.runs.some((run) => run.background && run.state === ActivityState.SUCCEEDED);
      } finally {
        controller.abort();
      }
    })
    .toBe(true);
});

test("keeps mobile task details within the viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/tasks");
  await expect(page.locator(".react-flow")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.locator(".react-flow__node-agent").first().click();
  await expect(page.getByTestId("agent-drawer")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
