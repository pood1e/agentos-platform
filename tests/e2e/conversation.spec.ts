import { expect, test } from "@playwright/test";
import { decideApproval, resetKagent, startOperation } from "./kagent.js";

test.beforeEach(async ({ request }) => resetKagent(request));

test("ordinary chat keeps its history and has no operational task", async ({ page }) => {
  await page.goto("/chat");
  const input = page.getByRole("textbox", { name: "消息", exact: true });
  await input.fill("你好，说明一下如何协作");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page).toHaveURL(/\/chat\/[^/]+$/);
  await expect(page.getByTestId("chat-message")).toHaveCount(2);
  await expect(page.getByTestId("chat-task")).toHaveCount(0);
  const url = page.url();
  await page.reload();
  await expect(page.getByTestId("chat-message")).toHaveCount(2);
  await page.goto("/");
  await expect(page).toHaveURL(url);
});

test("shows a native pending approval in the same conversation and retains a rejection reason", async ({
  page,
  request,
}) => {
  await startOperation(page);
  const approval = page.getByTestId("approval-detail");
  await expect(approval.getByTestId("approval-tool")).toHaveText("k8s_apply_manifest");
  await expect(approval.getByRole("button", { name: "拒绝", exact: true })).toBeVisible();
  await decideApproval(page, request, false, "保持现状，先检查依赖");
  await expect(approval).toHaveCount(0);
  await page.getByTestId("chat-task").click();
  await page.getByTestId("approval-node").first().click();
  await expect(page.getByTestId("rejection-reason")).toContainText("保持现状，先检查依赖");
  await page.reload();
  await page.getByTestId("approval-node").first().click();
  await expect(page.getByTestId("rejection-reason")).toContainText("保持现状，先检查依赖");
});
