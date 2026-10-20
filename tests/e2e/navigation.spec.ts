import { expect, test } from "@playwright/test";
import { resetKagent } from "./kagent.js";

test.beforeEach(async ({ request }) => resetKagent(request));

test("keeps sessions separated when selecting an Agent and returning home", async ({ page }) => {
  await page.goto("/chat");
  await page.getByRole("combobox", { name: "对话 Agent", exact: true }).click();
  await page.getByRole("option", { name: "inspection", exact: true }).click();
  await page.getByRole("textbox", { name: "消息", exact: true }).fill("编写产品简介");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.getByTestId("chat-message")).toHaveCount(2);
  await page.screenshot({ path: test.info().outputPath("agentos-console.png") });
  const session = page.url();
  expect(session).toContain("agent=inspection");
  await page.goto("/");
  await expect(page).toHaveURL(session);
  await expect(page.getByRole("combobox", { name: "对话 Agent", exact: true })).toContainText(
    "inspection",
  );
  await page.getByRole("combobox", { name: "对话 Agent", exact: true }).click();
  await page.getByRole("option", { name: "assistant", exact: true }).click();
  await expect(page.getByTestId("chat-message")).toHaveCount(0);
});
