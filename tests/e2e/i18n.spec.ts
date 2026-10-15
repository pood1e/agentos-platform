import { expect, test } from "@playwright/test";
import { resetKagent } from "./kagent.js";

test.beforeEach(async ({ request }) => resetKagent(request));

test("switches locale across routing, configuration and tool names", async ({ page }) => {
  await page.goto("/engineers");
  await page.getByRole("combobox", { name: "语言", exact: true }).click();
  await page.getByRole("option", { name: "English", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Advanced", exact: true })).toBeVisible();
  await page.locator('[data-testid="team-card"][data-role="inspection"] button').click();
  const editor = page.getByTestId("role-editor");
  await editor.getByRole("tab", { name: "Tools", exact: true }).click();
  await expect(editor.getByRole("checkbox", { name: "List resources", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.reload();
  await expect(page.getByRole("button", { name: "Add engineer", exact: true })).toBeVisible();
});

test("keeps the English skill editor usable on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => localStorage.setItem("agentos-language", "en"));
  await page.goto("/engineers");
  await page.getByRole("button", { name: "Add engineer", exact: true }).click();
  const editor = page.getByTestId("role-editor");
  await editor.getByRole("tab", { name: "Skills", exact: true }).click();
  await editor.getByRole("button", { name: "Add skill", exact: true }).click();
  await expect(editor.getByRole("textbox", { name: "Skill name", exact: true })).toBeVisible();
  await expect(editor.getByRole("button", { name: "Save", exact: true })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
