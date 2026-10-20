import { expect, test } from "@playwright/test";
import { identityToken } from "../fixtures/identity.js";
import { resetKagent } from "./kagent.js";

const token = await identityToken([], "reader-test");
test.use({ extraHTTPHeaders: { authorization: `Bearer ${token}` } });
test.beforeEach(async ({ request }) => resetKagent(request));

test("shows read-only chat without a message composer", async ({ page }) => {
  await page.goto("/chat");
  await expect(page.getByText("只读访问，可查看会话与任务。", { exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "消息", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "发送", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "新对话", exact: true })).toBeDisabled();
});

test("keeps pending approval details readable without mutation controls", async ({ page }) => {
  await page.goto("/tasks");
  await page.getByRole("link", { name: "待审批", exact: true }).click();
  const drawer = page.getByTestId("agent-drawer");
  await expect(drawer.getByTestId("approval-detail")).toBeVisible();
  await expect(drawer.getByTestId("approval-tool")).not.toHaveCount(0);
  await expect(page.getByRole("button", { name: "批准并继续", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "拒绝", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "停止", exact: true })).toHaveCount(0);
});
