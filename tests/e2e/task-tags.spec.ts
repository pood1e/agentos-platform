import { expect, test } from "@playwright/test";
import { client, ids, resetKagent } from "./kagent.js";

test.beforeEach(async ({ request }) => resetKagent(request));

test("edits preset and custom task tags, persists in the chat task panel and remains searchable", async ({
  page,
}) => {
  await page.goto(`/chat?task=${ids.approvalRoot}`);
  await page.getByRole("button", { name: "编辑标签", exact: true }).click();
  const editor = page.getByRole("dialog");
  await editor.getByRole("checkbox", { name: "分析", exact: true }).check();
  await editor.getByRole("textbox", { name: "新标签", exact: true }).fill("network");
  await editor.getByRole("button", { name: "添加标签", exact: true }).click();
  await editor.getByRole("button", { name: "保存", exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(page.getByTestId("task-tags")).toContainText("分析");
  await expect(page.getByTestId("task-tags")).toContainText("network");
  await expect.poll(async () => (await client.listTasks({ tags: ["analysis"] })).totalSize).toBe(1);
  await page.reload();
  await expect(page.getByTestId("task-tags")).toContainText("network");
  await page.getByRole("button", { name: "编辑标签", exact: true }).click();
  await editor.getByRole("checkbox", { name: "分析", exact: true }).uncheck();
  await editor.getByRole("checkbox", { name: "network", exact: true }).uncheck();
  await editor.getByRole("button", { name: "保存", exact: true }).click();
  await expect.poll(async () => (await client.listTasks({ tags: ["analysis"] })).totalSize).toBe(0);
  await expect(page.getByTestId("task-tags")).not.toContainText("network");
});

test("keeps long custom tags and the official tag editor inside a mobile viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { tasks } = await client.listTasks({ query: ids.approvalRoot });
  await client.updateTaskTags({
    taskId: ids.approvalRoot,
    tags: ["标签".repeat(20)],
    tagsVersion: tasks[0].tagsVersion,
  });
  await page.goto(`/chat?task=${ids.approvalRoot}`);
  await expect(page.getByTestId("task-tags")).toContainText("标签".repeat(20));
  await page.getByRole("button", { name: "编辑标签", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
