import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { expect, test } from "@playwright/test";
import { AutomationService } from "../../gen/agentos/automation/v1/service_pb.js";
import { identityToken, testToken } from "../fixtures/identity.js";
import { client, resetKagent } from "./kagent.js";

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

test("hides system tasks from ordinary users and rejects direct definitions and shared execution access", async ({
  page,
  context,
}) => {
  const schedule = (await api.listScheduledRuns({})).scheduledRuns[0];
  const { execution } = await api.triggerScheduledRun({
    scheduledRunId: schedule.id,
    requestId: crypto.randomUUID(),
  });
  const token = await identityToken(["writer"], "ordinary-writer");
  await context.setExtraHTTPHeaders({ authorization: `Bearer ${token}` });
  await page.goto("/system-tasks");
  await expect(page).toHaveURL(/\/chat$/);
  await expect(page.getByRole("link", { name: "系统任务", exact: true })).toHaveCount(0);
  const definitions = await context.request.post(
    "/agentos.automation.v1.AutomationService/ListScheduledRuns",
    { data: {} },
  );
  expect(definitions.status()).toBe(403);
  const runs = await context.request.post("/agentos.console.v1.ConsoleService/ListTasks", {
    data: { systemOnly: true },
  });
  expect(runs.status()).toBe(403);
  await page.goto(`/chat?task=${execution?.taskId}`);
  await expect(page.getByRole("alert")).toContainText("任务不存在或已不可见");
  await expect(page.getByTestId("task-title")).toHaveCount(0);
});

test("paginates and searches system-owned executions while excluding personal tasks", async ({
  page,
}) => {
  const schedule = (await api.listScheduledRuns({})).scheduledRuns[0];
  await Promise.all(
    Array.from({ length: 18 }, () =>
      api.triggerScheduledRun({ scheduledRunId: schedule.id, requestId: crypto.randomUUID() }),
    ),
  );
  await expect.poll(async () => (await client.listTasks({ systemOnly: true })).totalSize).toBe(18);
  const { tasks } = await client.listTasks({ systemOnly: true });
  await client.updateTaskTags({
    taskId: tasks[0].id,
    tags: ["system-history-proof"],
    tagsVersion: tasks[0].tagsVersion,
  });
  await page.goto("/system-tasks");
  const history = page.getByRole("region", { name: "运行历史", exact: true });
  await expect(history.getByRole("row")).toHaveCount(13);
  await expect(history).not.toContainText("验证独立测试环境审批和实际处置");
  await history.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(history.getByRole("row")).toHaveCount(7);
  await history
    .getByRole("textbox", { name: "搜索任务", exact: true })
    .fill("system-history-proof");
  await expect(history.getByRole("row")).toHaveCount(2);
  await expect(history).toContainText("system-history-proof");
  await history.getByRole("link", { name: "查看执行", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/system-tasks\\?task=${tasks[0].id}$`));
  await expect(page.getByTestId("chat-task-panel")).toBeVisible();
  await expect(page.getByTestId("chat-workspace")).toHaveCount(0);
  await page.getByRole("button", { name: "收起任务详情", exact: true }).click();
  await expect(page).toHaveURL(/\/system-tasks$/);
  await expect(history.getByRole("textbox", { name: "搜索任务", exact: true })).toHaveValue(
    "system-history-proof",
  );
  await expect(history.getByRole("row")).toHaveCount(2);
});

test("shows the system-task entry without a standalone task page and restores detail URLs", async ({
  page,
}) => {
  await page.goto("/chat");
  const navigation = page.getByRole("navigation", { name: "主导航", exact: true });
  await expect(navigation.getByRole("link", { name: "任务", exact: true })).toHaveCount(0);
  const system = navigation.getByRole("link", { name: "系统任务", exact: true });
  await system.click();
  await expect(page).toHaveURL(/\/system-tasks$/);
  await expect(page.getByRole("heading", { name: "系统任务", level: 1 })).toBeVisible();
  await expect(system).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("scheduled-run-row")).toHaveCount(2);
  await page.getByRole("button", { name: "例行检查", exact: true }).click();
  await expect(page).toHaveURL(/\/system-tasks\/[^/]+$/);
  const url = page.url();
  await page.reload();
  await expect(page).toHaveURL(url);
  await expect(page.getByRole("dialog")).toContainText("尚无运行记录");
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(page).toHaveURL(/\/system-tasks$/);
  await navigation.getByRole("link", { name: "聊天", exact: true }).click();
  await expect(page.getByTestId("conversation")).toBeVisible();
});

test("creates, edits, enables and deletes a scheduled task through the native API", async ({
  page,
}) => {
  await page.goto("/system-tasks");
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

test("keeps a scheduled execution in the system-task workspace across reload and mobile navigation", async ({
  page,
}) => {
  await page.goto("/system-tasks");
  const row = page.getByTestId("scheduled-run-row").filter({ hasText: "例行检查" });
  await row.getByRole("button", { name: "立即执行", exact: true }).click();
  const detail = page.getByRole("dialog");
  await expect(detail).toContainText("手动触发");
  await expect(detail).toContainText("系统只读身份");
  await detail.getByRole("link", { name: "查看执行", exact: true }).click();
  await expect(page).toHaveURL(/\/system-tasks\?task=[0-9a-f-]+$/);
  await expect(detail).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "系统任务", level: 1 })).toBeVisible();
  await expect(page.getByRole("link", { name: "系统任务", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(page.getByTestId("chat-workspace")).toHaveCount(0);
  await expect(page.getByTestId("task-title")).toBeVisible();
  await expect(page.getByTestId("chat-task-panel")).toContainText("检查工作负载健康");
  const url = page.url();
  await page.reload();
  await expect(page).toHaveURL(url);
  await expect(page.getByTestId("task-title")).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("system-task-execution-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId("chat-task-panel")).toBeVisible();
  await expect(page.getByRole("region", { name: "定时任务", exact: true })).not.toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: test.info().outputPath("system-task-execution-mobile.png") });
  await page.getByRole("button", { name: "收起任务详情", exact: true }).click();
  await expect(page).toHaveURL(/\/system-tasks$/);
  await expect(row).toBeVisible();
  await expect(page.getByTestId("chat-task-panel")).toHaveCount(0);
});

test("lets another platform administrator inspect shared task history and rejects direct scheduling mutations", async ({
  page,
  context,
}) => {
  const schedule = (await api.listScheduledRuns({})).scheduledRuns[0];
  await api.triggerScheduledRun({ scheduledRunId: schedule.id, requestId: crypto.randomUUID() });
  const token = await identityToken(["agentos-agents-manage"], "system-task-reader");
  await context.setExtraHTTPHeaders({ authorization: `Bearer ${token}` });
  await page.goto(`/system-tasks/${schedule.id}`);
  await expect(page.getByRole("dialog")).toContainText("手动触发");
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(page.getByRole("link", { name: "系统任务", exact: true })).toHaveAttribute(
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
  await expect(page).toHaveURL(/\/system-tasks\?task=[0-9a-f-]+$/);
  await expect(page.getByTestId("chat-workspace")).toHaveCount(0);
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
  await page.goto("/chat");
  await page.getByRole("button", { name: "主导航", exact: true }).click();
  const menu = page.getByRole("dialog");
  await menu.getByRole("link", { name: "系统任务", exact: true }).click();
  await expect(menu).toHaveCount(0);
  await expect(page).toHaveURL(/\/system-tasks$/);
  await expect(page.getByRole("heading", { name: "系统任务", level: 1 })).toBeVisible();
  const event = page.getByTestId("event-trigger-row");
  await expect(event).toContainText("production");
  await expect(event).toContainText("平台入口未启用");
  await expect(event).toContainText("alert.lifecycle.*");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: test.info().outputPath("automations-mobile.png") });
  await page.getByRole("button", { name: "主导航", exact: true }).click();
  await expect(menu.getByRole("link", { name: "系统任务", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await menu.getByRole("link", { name: "聊天", exact: true }).click();
  await expect(menu).toHaveCount(0);
  await expect(page.getByTestId("conversation")).toBeVisible();
  await page.getByRole("button", { name: "主导航", exact: true }).click();
  await menu.getByRole("link", { name: "系统任务", exact: true }).click();
  await page.getByRole("button", { name: "新建定时任务", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
