import { expect, test } from "@playwright/test";
import { resetKagent } from "./kagent.js";

test.beforeEach(async ({ request }) => resetKagent(request));
test("renders a real MCP App across the isolated proxy, handles callbacks and follows theme", async ({
  page,
  request,
}) => {
  const setup = await request.post("http://127.0.0.1:8094/apps");
  expect(setup.ok()).toBe(true);
  const { contextId, taskId, callId } = await setup.json();
  await page.route("**/agentos.console.v1.ConsoleService/CallAppTool", async (route) => {
    const params = route.request().postDataJSON();
    if (params.name !== "graph_data") return route.continue();
    expect(params).toMatchObject({
      app: { taskId, callId },
      name: "graph_data",
      arguments: { value: { focus: "router-1" } },
    });
    await route.fulfill({
      json: {
        result: {
          value: { content: [{ type: "text", text: "graph" }], structuredContent: { nodes: 12 } },
        },
      },
    });
  });
  await page.goto(`/chat/${contextId}`);
  const app = page.getByTestId("mcp-app");
  await expect(app).toBeVisible();
  await expect(app.locator("iframe")).toHaveCount(0);
  await app.getByRole("button", { name: "展开视图", exact: true }).click();
  await expect(page.getByTestId("chat-tool-group").getByTestId("mcp-app")).toHaveCount(0);
  const view = app.frameLocator("iframe").frameLocator("iframe");
  await expect(view.getByRole("heading", { name: "Topology App" })).toBeVisible();
  await expect(view.locator("body")).toHaveAttribute("data-data-resource", "loaded");
  await expect(view.locator("#input")).toContainText("datacenter");
  await expect(view.locator("#result")).toContainText("8080");
  await view.getByRole("button", { name: "Refresh graph" }).click();
  await expect(view.locator("output")).toContainText('"nodes":12');
  await view.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "消息", exact: true })).toHaveValue(
    "继续检查 router-1",
  );
  await view.getByRole("button", { name: "Unsafe link" }).click();
  await expect(view.locator("#denied")).toHaveText("blocked");
  await view.getByRole("button", { name: "Write tool", exact: true }).click();
  await expect(view.locator("#denied")).toHaveText("blocked destroy");
  await view.getByRole("button", { name: "Other service", exact: true }).click();
  await expect(view.locator("#denied")).toHaveText("blocked other-service_graph_data");
  await page.evaluate(() => {
    localStorage.setItem("agentos-theme", "dark");
    window.dispatchEvent(new StorageEvent("storage", { key: "agentos-theme", newValue: "dark" }));
  });
  await expect(view.locator("#theme")).toHaveText("dark");
  await app.getByRole("button", { name: "全屏查看", exact: true }).click();
  await expect(app.getByRole("button", { name: "退出全屏", exact: true })).toBeVisible();
  await app.getByRole("button", { name: "退出全屏", exact: true }).click();
  await expect(app.getByRole("button", { name: "全屏查看", exact: true })).toBeVisible();
  expect(
    await view.locator("body").evaluate(() => {
      try {
        return window.top?.document.cookie;
      } catch {
        return "isolated";
      }
    }),
  ).toBe("isolated");
  await page.screenshot({ path: test.info().outputPath("mcp-app-desktop.png") });
});
