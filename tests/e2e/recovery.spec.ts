import { expect, test } from "@playwright/test";
import { decideWorkOrder, ids, resetKagent, startOperation, workOrders } from "./kagent.js";

test("keeps an engineer successful after an earlier tool failure and exposes the actual call", async ({
  page,
  request,
}) => {
  await resetKagent(request);
  await workOrders(page);
  await startOperation(page);
  await decideWorkOrder(page, request, true);
  await page.getByTestId("chat-task").click();
  const engineer = page
    .locator('[data-testid="collaboration-step"][data-agent="agentos/remediation"]')
    .first();
  await expect(engineer).toHaveAttribute("data-state", "SUCCEEDED");
  await engineer.click();
  const drawer = page.getByTestId("agent-drawer");
  await expect(drawer.getByTestId("drawer-call").first()).toBeVisible();
  await expect(drawer.locator('[data-tool-name="k8s_get_resource_yaml"]').first()).toContainText(
    "失败",
  );
  const tool = drawer.locator('[data-tool-name="k8s_get_resources"]').first();
  await expect(tool).toContainText("查询资源列表");
  await expect(tool.getByRole("button")).not.toContainText("k8s_get_resources");
  await tool.getByRole("button").click();
  await expect(tool.getByRole("region", { name: "调用详情", exact: true })).toContainText(
    "k8s_get_resources",
  );
  await expect(tool.getByTestId("tool-icon")).toHaveAttribute("data-tool-brand", "Kubernetes");
});

test("shows failed execution details and retries without closing the drawer", async ({
  page,
  request,
}) => {
  await resetKagent(request);
  let failed = true;
  await page.route("**/agentos.console.v1.ConsoleService/GetTaskRun", (route) =>
    failed
      ? route.fulfill({
          status: 503,
          json: { code: "unavailable", message: "Details unavailable" },
        })
      : route.continue(),
  );
  await page.goto(`/tasks/${ids.dispatchRoot}`);
  await page.locator(".react-flow__node-agent").first().click();
  const drawer = page.getByTestId("agent-drawer");
  await expect(drawer.getByRole("alert")).toContainText("暂时无法加载执行详情");
  failed = false;
  await drawer.getByRole("button", { name: "重试", exact: true }).click();
  await expect(drawer.getByRole("alert")).toHaveCount(0);
  await expect(drawer.getByTestId("task-prompt")).toBeVisible();
  await expect(drawer.getByTestId("drawer-call").first()).toBeVisible();
});
