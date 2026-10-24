import { expect, test } from "@playwright/test";
import { ActivityState } from "../../gen/agentos/execution/v1/state_pb.js";
import { client, decideApproval, resetKagent, startOperation } from "./kagent.js";

test.beforeEach(async ({ request }) => resetKagent(request));

test("finishes delegated work inline and retains only child results", async ({ page, request }) => {
  await startOperation(page);
  const contextId = new URL(page.url()).pathname.split("/").at(-1);
  const { tasks } = await client.listTasks({});
  const task = tasks.find((item) => item.conversationContextId === contextId);
  expect(task).toBeDefined();
  await expect(page.getByTestId("chat-task-panel")).toHaveCount(0);
  await decideApproval(page, request, true);
  await expect
    .poll(async () => (await client.listTasks({ query: task?.id })).tasks[0]?.state, {
      timeout: 20000,
    })
    .toBe(ActivityState.SUCCEEDED);
  await expect(page.getByTestId("chat-agent-result")).not.toHaveCount(0);
  await expect(page.getByTestId("conversation")).toContainText(
    "用户决定已处理，执行结果已核验；知识正在后台沉淀。",
  );
  await expect(page.getByTestId("chat-working-agents")).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("compact-chat-results.png") });
  await page.reload();
  await expect(page.getByTestId("chat-agent-result")).not.toHaveCount(0);
  await expect(page.getByTestId("chat-task-panel")).toHaveCount(0);
});

test("keeps the composer and worker area visible on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await startOperation(page);
  await expect(page.getByTestId("conversation")).toBeVisible();
  await expect(page.getByTestId("chat-working-agents")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "消息", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: test.info().outputPath("compact-chat-mobile.png") });
});
