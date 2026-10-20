import { expect, test } from "@playwright/test";
import { resetKagent } from "./kagent.js";

test.beforeEach(async ({ request }) => resetKagent(request));

test("keeps assistant conversations separate and restores the current user's last conversation", async ({
  page,
}) => {
  await page.goto("/chat");
  await page.getByRole("textbox", { name: "消息", exact: true }).fill("编写产品简介");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.getByTestId("chat-message")).toHaveCount(2);
  await page.screenshot({ path: test.info().outputPath("agentos-console.png") });
  const session = page.url();
  expect(new URL(session).search).toBe("");
  await page.goto("/");
  await expect(page).toHaveURL(session);
  await expect(page.getByRole("combobox", { name: "对话 Agent", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "新对话", exact: true }).click();
  await expect(page.getByTestId("chat-message")).toHaveCount(0);
  await page.getByTestId("chat-history").getByTestId("history-entry").first().click();
  await expect(page).toHaveURL(session);
  await expect(page.getByTestId("chat-message")).toHaveCount(2);
});
