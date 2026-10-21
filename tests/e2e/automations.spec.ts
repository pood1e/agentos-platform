import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { expect, test } from "@playwright/test";
import { AutomationService } from "../../gen/agentos/automation/v1/service_pb.js";
import { identityToken, testToken } from "../fixtures/identity.js";
import { resetKagent } from "./kagent.js";

const api = createClient(
  AutomationService,
  createConnectTransport({
    baseUrl: "http://127.0.0.1:8090",
    httpVersion: "1.1",
    interceptors: [
      (next) => (request) => {
        request.header.set("authorization", `Bearer ${testToken}`);
        return next(request);
      },
    ],
  }),
);
test.beforeEach(async ({ request }) => resetKagent(request));

test("navigates independent task and automation pages and restores automation detail URLs", async ({
  page,
}) => {
  await page.goto("/tasks");
  const navigation = page.getByRole("navigation", { name: "主导航", exact: true });
  const tasks = navigation.getByRole("link", { name: "任务", exact: true });
  const automations = navigation.getByRole("link", { name: "自动化任务", exact: true });
  await expect(page.getByRole("heading", { name: "任务", level: 1, exact: true })).toBeVisible();
  await expect(tasks).toHaveAttribute("aria-current", "page");
  await expect(automations).not.toHaveAttribute("aria-current");
  await expect(page.getByRole("tab", { name: "自动化任务", exact: true })).toHaveCount(0);
  await automations.click();
  await expect(page).toHaveURL(/\/automations$/);
  await expect(page.getByRole("heading", { name: "自动化任务", level: 1 })).toBeVisible();
  await expect(automations).toHaveAttribute("aria-current", "page");
  await expect(tasks).not.toHaveAttribute("aria-current");
  await expect(page.getByTestId("scheduled-run-row")).toHaveCount(2);
  await expect(page.getByTestId("scheduled-run-row").first()).toContainText("已暂停");
  await page.screenshot({ path: test.info().outputPath("automations-desktop.png") });
  await page.getByRole("button", { name: "例行检查", exact: true }).click();
  await expect(page).toHaveURL(/\/automations\/[^/]+$/);
  const detailUrl = page.url();
  await page.reload();
  await expect(page).toHaveURL(detailUrl);
  await expect(page.getByRole("dialog")).toContainText("尚无运行记录");
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(page).toHaveURL(/\/automations$/);
  await expect(automations).toHaveAttribute("aria-current", "page");
  await tasks.click();
  await expect(page.getByTestId("task-history")).toBeVisible();
  await expect(tasks).toHaveAttribute("aria-current", "page");
  await expect(automations).not.toHaveAttribute("aria-current");
  await page.screenshot({ path: test.info().outputPath("tasks-desktop.png") });
});

test("creates, edits, enables and deletes a scheduled task through the native API", async ({
  page,
}) => {
  await page.goto("/automations");
  await page.getByRole("button", { name: "新建定时任务", exact: true }).click();
  const editor = page.getByRole("dialog");
  await editor.getByLabel("任务名称", { exact: true }).fill("工作日巡检");
  await editor.getByRole("combobox", { name: "执行智能体", exact: true }).click();
  await page.getByRole("option", { name: "巡检工程师", exact: true }).click();
  await editor.getByLabel("Cron 表达式", { exact: true }).fill("0 8 * * 1-5");
  await editor.getByLabel("时区", { exact: true }).fill("Asia/Shanghai");
  await editor.getByLabel("任务内容", { exact: true }).fill("读取当前健康状况并形成简短报告。");
  await editor.getByRole("button", { name: "保存", exact: true }).click();
  await expect(editor).toHaveCount(0);
  const row = page.getByTestId("scheduled-run-row").filter({ hasText: "工作日巡检" });
  await expect(row).toContainText("已暂停");
  await row.getByRole("button", { name: "更多操作", exact: true }).click();
  await page.getByRole("menuitem", { name: "编辑定时任务", exact: true }).click();
  await editor.getByLabel("任务名称", { exact: true }).fill("工作日例行巡检");
  await editor.getByRole("button", { name: "保存", exact: true }).click();
  const updated = page.getByTestId("scheduled-run-row").filter({ hasText: "工作日例行巡检" });
  await expect(editor).toHaveCount(0);
  await updated.getByRole("button", { name: "启用", exact: true }).click();
  await expect(updated).toContainText("已启用");
  await page.reload();
  await expect(updated).toContainText("0 8 * * 1-5");
  await updated.getByRole("button", { name: "暂停", exact: true }).click();
  await expect(updated).toContainText("已暂停");
  await updated.getByRole("button", { name: "更多操作", exact: true }).click();
  await page.getByRole("menuitem", { name: "删除定时任务", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "确认", exact: true }).click();
  await expect(updated).toHaveCount(0);
});

test("runs a paused shared task and links its native execution to the existing task view", async ({
  page,
}) => {
  await page.goto("/automations");
  const row = page.getByTestId("scheduled-run-row").filter({ hasText: "例行检查" });
  await row.getByRole("button", { name: "立即执行", exact: true }).click();
  const detail = page.getByRole("dialog");
  await expect(detail).toContainText("手动触发");
  await expect(detail).toContainText("系统只读身份");
  await detail.getByRole("link", { name: "查看执行", exact: true }).click();
  await expect(page).toHaveURL(/\/tasks\/[0-9a-f-]+$/);
  await expect(page.getByTestId("task-title")).toBeVisible();
  await expect(page.getByTestId("task-history")).toContainText("检查工作负载健康");
});

test("lets another reader inspect shared task history and rejects direct scheduling mutations", async ({
  page,
  context,
}) => {
  const schedule = (await api.listScheduledRuns({})).scheduledRuns[0];
  await api.triggerScheduledRun({ scheduledRunId: schedule.id, requestId: crypto.randomUUID() });
  const token = await identityToken([], "automation-reader");
  await context.setExtraHTTPHeaders({ authorization: `Bearer ${token}` });
  await page.goto(`/automations/${schedule.id}`);
  await expect(page.getByRole("dialog")).toContainText("手动触发");
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(page.getByRole("link", { name: "自动化任务", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(page.getByTestId("scheduled-run-row")).toHaveCount(2);
  for (const label of ["新建定时任务", "立即执行", "编辑定时任务", "删除定时任务", "启用"])
    await expect(page.getByRole("button", { name: label, exact: true })).toHaveCount(0);
  const denied = await context.request.post(
    "/agentos.automation.v1.AutomationService/TriggerScheduledRun",
    {
      headers: { "content-type": "application/json", origin: "http://127.0.0.1:8090" },
      data: { scheduledRunId: schedule.id, requestId: crypto.randomUUID() },
    },
  );
  expect(denied.status()).toBe(403);
  await page.getByRole("button", { name: schedule.config?.name, exact: true }).click();
  await page.getByRole("dialog").getByRole("link", { name: "查看执行", exact: true }).click();
  await expect(page.getByTestId("task-title")).toBeVisible();
});

test("shows environment-owned event ingress accurately and keeps automation cards usable on mobile", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("**/agentos.automation.v1.AutomationService/ListEventTriggers", (route) =>
    route.fulfill({
      json: {
        eventTriggers: [
          {
            environment: "production",
            ingressEnabled: false,
            trigger: {
              eventNamespace: "operations",
              source: { typePrefix: "alert.lifecycle." },
              agent: { namespace: "agentos", name: "inspection" },
            },
          },
        ],
      },
    }),
  );
  await page.goto("/tasks");
  await page.getByRole("button", { name: "主导航", exact: true }).click();
  const menu = page.getByRole("dialog");
  await menu.getByRole("link", { name: "自动化任务", exact: true }).click();
  await expect(menu).toHaveCount(0);
  await expect(page).toHaveURL(/\/automations$/);
  await expect(page.getByRole("heading", { name: "自动化任务", level: 1 })).toBeVisible();
  const event = page.getByTestId("event-trigger-row");
  await expect(event).toContainText("production");
  await expect(event).toContainText("平台入口未启用");
  await expect(event).toContainText("alert.lifecycle.*");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: test.info().outputPath("automations-mobile.png") });
  await page.getByRole("button", { name: "主导航", exact: true }).click();
  await expect(menu.getByRole("link", { name: "自动化任务", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await menu.getByRole("link", { name: "任务", exact: true }).click();
  await expect(menu).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "任务", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "主导航", exact: true }).click();
  await menu.getByRole("link", { name: "自动化任务", exact: true }).click();
  await page.getByRole("button", { name: "新建定时任务", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
