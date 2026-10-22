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

test("keeps platform connectivity live when an individual resource query fails", async ({
  page,
  request,
}) => {
  await resetKagent(request);
  await page.route("**/agentos.console.v1.ConsoleService/ListConversations", (route) =>
    route.abort(),
  );
  await page.goto("/chat");
  await expect(page.getByTestId("connection")).toHaveAttribute("data-state", "connected");
  const calls = [];
  for (let index = 0; index < 3; index++) {
    await page.waitForResponse((response) => response.url().endsWith("/GetAccessProfile"));
    calls.push(await page.getByTestId("connection").getAttribute("data-state"));
    await expect(page.getByTestId("error-banner")).toHaveCount(0);
  }
  expect(calls).toEqual(["connected", "connected", "connected"]);
});

test("reauthenticates an expired browser session while preserving the conversation URL", async ({
  page,
  request,
}) => {
  await resetKagent(request);
  await page.goto(`/chat?task=${ids.dispatchRoot}`);
  await expect(page.locator(".react-flow__node-agent").first()).toBeVisible();
  const url = page.url();
  let rejected = false;
  await page.route("**/agentos.console.v1.ConsoleService/GetAccessProfile", (route) => {
    if (rejected) return route.continue();
    rejected = true;
    return route.fulfill({ status: 401, json: { code: "unauthenticated", message: "expired" } });
  });
  await page.waitForEvent("framenavigated", {
    predicate: (frame) => frame === page.mainFrame(),
    timeout: 20_000,
  });
  await expect(page).toHaveURL(url);
  await expect(page.locator(".react-flow__node-agent").first()).toBeVisible();
  await expect(page.getByTestId("connection")).toHaveAttribute("data-state", "connected");
});
