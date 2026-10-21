import { expect, test } from "@playwright/test";
import { ids, resetKagent } from "./kagent.js";

test("follows system appearance and persists a manual dark theme", async ({ page, request }) => {
  await resetKagent(request);
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/chat");
  await expect(page.locator("html")).toHaveClass("dark");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveClass("light");
  await page.getByRole("combobox", { name: "外观主题", exact: true }).click();
  await page.getByRole("option", { name: "暗色", exact: true }).click();
  await page.reload();
  await expect(page.locator("html")).toHaveClass("dark");
});

test("recolors the graph and its drawer without resetting the viewport", async ({
  page,
  request,
}) => {
  await resetKagent(request);
  await page.goto(`/chat?task=${ids.dispatchRoot}`);
  await expect(page.locator(".react-flow__node-agent").first()).toBeVisible();
  await page.locator(".react-flow__controls-zoomout").click();
  const viewport = await page.locator(".react-flow__viewport").getAttribute("style");
  await page.getByRole("combobox", { name: "外观主题", exact: true }).click();
  await page.getByRole("option", { name: "暗色", exact: true }).click();
  await expect(page.locator(".react-flow")).toHaveClass(/dark/);
  await expect(page.locator(".react-flow__viewport")).toHaveAttribute("style", viewport ?? "");
  await page.locator(".react-flow__node-agent").first().click();
  await expect(page.getByTestId("agent-drawer")).toBeVisible();
  await expect(page.locator("html")).toHaveClass("dark");
});
