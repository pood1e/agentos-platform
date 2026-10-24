import { expect, type Page, test } from "@playwright/test";
import { TaskState } from "../../gen/a2a_pb.js";
import type { Interaction } from "../../gen/agentos/console/v1/task_pb.js";
import { ActivityState } from "../../gen/agentos/execution/v1/state_pb.js";
import { client, ids, observeTask, recordedTask, resetKagent, startOperation } from "./kagent.js";

test.beforeEach(async ({ request }) => resetKagent(request));

async function send(page: Page, text: string) {
  await expect(page).toHaveURL(/\/chat$/);
  await expect(page.getByTestId("chat-message")).toHaveCount(0);
  await page.getByRole("textbox", { name: "消息", exact: true }).fill(text);
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page).toHaveURL(/\/chat\/[^/?]+$/);
  await expect(page.getByTestId("chat-message").last()).toContainText(`已处理：${text}`);
  return new URL(page.url()).pathname.split("/").at(-1) ?? "";
}

test("places new chat in history and permanently deletes current and other owned conversations", async ({
  page,
}) => {
  await client.deleteSession({ sessionId: ids.chatContext });
  await page.goto("/chat");
  const history = page.getByTestId("chat-history");
  await expect(history.getByRole("button", { name: "新聊天", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "新聊天", exact: true })).toHaveCount(1);
  const first = await send(page, "会话一");
  await history.getByRole("button", { name: "新聊天", exact: true }).click();
  const second = await send(page, "会话二");
  const row = (id: string) =>
    history.locator(`[data-testid="history-row"][data-context-id="${id}"]`);
  await expect(row(first)).toContainText("已完成");
  await row(first).getByRole("button", { name: "会话操作", exact: true }).click();
  await page.getByRole("menuitem", { name: "删除会话", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "删除会话", exact: true });
  await expect(dialog).toContainText("会话一");
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(row(first)).toBeVisible();
  await row(first).getByRole("button", { name: "会话操作", exact: true }).click();
  await page.getByRole("menuitem", { name: "删除会话", exact: true }).click();
  await dialog.getByRole("button", { name: "确认", exact: true }).click();
  await expect(row(first)).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/chat/${second}$`));
  await page.reload();
  await expect(row(first)).toHaveCount(0);
  await expect(row(second)).toBeVisible();
  await row(second).getByRole("button", { name: "会话操作", exact: true }).click();
  await page.getByRole("menuitem", { name: "删除会话", exact: true }).click();
  await dialog.getByRole("button", { name: "确认", exact: true }).click();
  await expect(page).toHaveURL(/\/chat$/);
  await expect(history).toContainText("暂无聊天");
  await page.goto("/");
  await expect(page).toHaveURL(/\/chat$/);
  await expect(history.getByTestId("history-entry")).toHaveCount(0);
});

test("shows live native status and disables deletion until delegated work finishes", async ({
  page,
}) => {
  await startOperation(page);
  const contextId = new URL(page.url()).pathname.split("/").at(-1);
  const row = page.getByTestId("chat-history").locator(`[data-context-id="${contextId}"]`);
  await expect(row).toContainText("待审批", { timeout: 10000 });
  await row.getByRole("button", { name: "会话操作", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: "删除会话", exact: true })).toBeDisabled();
  await expect(page.getByRole("menu")).toContainText("结束后才能删除");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "批准并继续", exact: true }).click();
  await expect(row).toContainText("已完成", { timeout: 20000 });
  await row.getByRole("button", { name: "会话操作", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: "删除会话", exact: true })).toBeEnabled();
  await page.keyboard.press("Escape");
  await page.screenshot({ path: test.info().outputPath("chat-history-status-desktop.png") });
});

test("provides history search, new chat and deletion in the mobile drawer", async ({ page }) => {
  await client.deleteSession({ sessionId: ids.chatContext });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/chat");
  await page.getByRole("button", { name: "聊天记录", exact: true }).click();
  const drawer = page.getByRole("dialog", { name: "聊天记录", exact: true });
  await drawer.getByRole("button", { name: "新聊天", exact: true }).click();
  await expect(drawer).toHaveCount(0);
  const contextId = await send(page, "手机聊天");
  await page.getByRole("button", { name: "聊天记录", exact: true }).click();
  await drawer.getByRole("textbox", { name: "搜索聊天", exact: true }).fill("手机");
  const row = drawer.locator(`[data-context-id="${contextId}"]`);
  await expect(row).toContainText("已完成");
  await page.screenshot({ path: test.info().outputPath("chat-history-mobile.png") });
  await row.getByRole("button", { name: "会话操作", exact: true }).click();
  await page.getByRole("menuitem", { name: "删除会话", exact: true }).click();
  await page
    .getByRole("dialog", { name: "删除会话", exact: true })
    .getByRole("button", { name: "确认", exact: true })
    .click();
  await expect(row).toHaveCount(0);
  await expect(page).toHaveURL(/\/chat$/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test("continues delegated execution after closing the page and restores results on return", async ({
  page,
  context,
}) => {
  await startOperation(page);
  const contextId = new URL(page.url()).pathname.split("/").at(-1) ?? "";
  const operation = (await client.listTasks({})).tasks.find(
    (task) => task.conversationContextId === contextId,
  );
  if (!operation) throw new Error("Delegated operation missing");
  let interaction: Interaction | undefined;
  for await (const { task } of client.watchTask({ taskId: operation.id })) {
    interaction = task?.interactions.find((item) => item.state === ActivityState.AWAITING_APPROVAL);
    break;
  }
  if (!interaction) throw new Error("Pending interaction missing");
  await page.close();
  await client.respondInteraction({
    taskId: interaction.taskId,
    requestId: interaction.requestId,
    decision: {
      case: "approval",
      value: { approvals: interaction.tools.map((tool) => ({ id: tool.id, approved: true })) },
    },
  });
  await expect
    .poll(async () => (await client.listTasks({ query: operation.id })).tasks[0]?.state, {
      timeout: 20000,
    })
    .toBe(ActivityState.SUCCEEDED);
  const restored = await context.newPage();
  await restored.goto(`/chat/${contextId}`);
  await expect(restored.getByTestId("chat-agent-result")).not.toHaveCount(0);
  await expect(
    restored.getByTestId("chat-history").locator(`[data-context-id="${contextId}"]`),
  ).toContainText("已完成", { timeout: 10000 });
});

test("shows execution failure and cancellation from native task state", async ({
  page,
  request,
}) => {
  const task = await recordedTask(request, ids.chat);
  task.artifacts = [];
  if (task.status) task.status.state = TaskState.FAILED;
  await observeTask(request, task);
  await page.goto(`/chat/${task.contextId}`);
  const row = page.getByTestId("chat-history").locator(`[data-context-id="${task.contextId}"]`);
  await expect(row).toContainText("失败");
  if (task.status) task.status.state = TaskState.CANCELED;
  await observeTask(request, task);
  await expect(row).toContainText("已取消", { timeout: 10000 });
});
