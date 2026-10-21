import { expect, test } from "@playwright/test";
import { ids, resetKagent } from "./kagent.js";

test("retains graph observations and zoom while queries reconnect", async ({ page, request }) => {
  await resetKagent(request);
  await page.goto(`/chat?task=${ids.dispatchRoot}`);
  await expect(page.locator(".react-flow__node-agent").first()).toBeVisible();
  await page.locator(".react-flow__controls-zoomout").click();
  const viewport = page.locator(".react-flow__viewport");
  const zoom = () => viewport.evaluate((node) => getComputedStyle(node).transform.split(",")[0]);
  const position = await zoom();
  let offline = true;
  await page.route("**/agentos.console.v1.ConsoleService/**", (route) =>
    offline ? route.abort() : route.continue(),
  );
  await expect(page.getByTestId("connection")).toHaveAttribute("data-state", "disconnected", {
    timeout: 15_000,
  });
  await expect(page.getByTestId("error-banner")).toBeVisible({ timeout: 10_000 });
  await expect.poll(zoom).toBe(position);
  offline = false;
  await expect(page.getByTestId("connection")).toHaveAttribute("data-state", "connected", {
    timeout: 15_000,
  });
  await expect(page.getByTestId("error-banner")).toHaveCount(0);
  await expect.poll(zoom).toBe(position);
});
