import { expect, test } from "@playwright/test";
import { resetKagent } from "./kagent.js";

test.beforeEach(async ({ request }) => resetKagent(request));

test("shows and counts runtime tools without persisting them as MCP bindings", async ({ page }) => {
  await page.goto("/engineers");
  const knowledge = page.locator('[data-testid="team-card"][data-role="knowledge"]');
  await expect(knowledge).toContainText("工具 4");
  await knowledge.getByRole("button", { name: "配置", exact: true }).click();
  const editor = page.getByTestId("role-editor");
  await editor.getByRole("tab", { name: "工具", exact: true }).click();
  const builtin = editor.getByTestId("builtin-tools");
  await expect(builtin.locator("[data-tool-name]")).toHaveCount(4);
  for (const name of ["询问用户", "沉淀知识", "检索历史知识", "自动检索知识"])
    await expect(builtin.getByText(name, { exact: true })).toBeVisible();
  await expect(builtin.getByRole("checkbox")).toHaveCount(0);
  await expect(builtin.locator('[data-tool-brand="kagent"]')).toHaveCount(5);
  const search = editor.getByRole("textbox", { name: "搜索工具", exact: true });
  await search.fill("自动检索");
  await expect(builtin.locator("[data-tool-name]")).toHaveCount(1);
  await expect(editor.getByText("没有匹配的工具", { exact: true })).toHaveCount(0);
  await search.fill("");
  await editor.getByRole("button", { name: "保存", exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(knowledge).toContainText("工具 4");
  const response = await page.request.post("/agentos.console.v1.ConsoleService/GetConfiguration", {
    data: {},
  });
  const configuration = await response.json();
  expect(
    configuration.roles.find((role: { name: string }) => role.name === "knowledge").tools ?? [],
  ).toEqual([]);
});

test("builds a role and preserves prompt, skill and MCP drafts across tabs", async ({ page }) => {
  await page.goto("/engineers");
  await expect(page.getByTestId("team-card")).toHaveCount(5);
  await page.getByRole("button", { name: "新增工程师", exact: true }).click();
  const editor = page.getByTestId("role-editor");
  await expect(editor.getByRole("tab")).toHaveCount(4);
  await editor.getByRole("tab", { name: "运行时", exact: true }).click();
  await editor.getByRole("combobox", { name: "Harness", exact: true }).click();
  await page.getByRole("option", { name: "Codex · Codex", exact: true }).click();
  await editor.getByRole("tab", { name: "提示词", exact: true }).click();
  await editor.getByRole("textbox", { name: "工程师需求", exact: true }).fill("创建只读巡检工程师");
  await editor.getByRole("button", { name: "生成草稿", exact: true }).click();
  await expect(editor.getByLabel("名称", { exact: true })).toHaveValue("巡检助手");
  await editor.getByLabel("标识", { exact: true }).fill("browser-readonly");
  await editor.getByRole("tab", { name: "技能", exact: true }).click();
  await editor.getByRole("button", { name: "添加技能", exact: true }).click();
  await editor.getByRole("textbox", { name: "技能名称", exact: true }).fill("triage");
  await editor
    .getByRole("textbox", { name: "镜像地址（含 SHA-256）", exact: true })
    .fill(`registry.example.com/triage@sha256:${"1".repeat(64)}`);
  await editor.getByRole("tab", { name: "工具", exact: true }).click();
  await expect(editor.getByRole("checkbox", { name: "查询资源列表", exact: true })).toBeChecked();
  await expect(editor.getByRole("checkbox", { name: "检索团队知识", exact: true })).toBeChecked();
  const search = editor.getByRole("textbox", { name: "搜索工具", exact: true });
  await search.fill("应用资源变更");
  await expect(editor.getByRole("checkbox", { name: "应用资源变更", exact: true })).toBeDisabled();
  await search.fill("");
  await editor.getByRole("tab", { name: "提示词", exact: true }).click();
  await expect(editor.getByLabel("职责与工作方式", { exact: true })).toHaveValue(/只读工具/);
  await editor.getByRole("button", { name: "保存", exact: true }).click();
  await expect(editor).toHaveCount(0);
  const member = page.getByTestId("team-card").filter({ hasText: "巡检助手" });
  await expect(member).toBeVisible();
  await member.getByRole("button", { name: "配置", exact: true }).click();
  await editor.getByRole("tab", { name: "工具", exact: true }).click();
  await expect(editor.getByRole("checkbox", { name: "查询资源列表", exact: true })).toBeChecked();
  await editor.getByRole("tab", { name: "技能", exact: true }).click();
  await expect(editor.getByRole("textbox", { name: "技能名称", exact: true })).toHaveValue(
    "triage",
  );
  await editor.getByRole("tab", { name: "运行时", exact: true }).click();
  await expect(editor.getByRole("combobox", { name: "Harness", exact: true })).toContainText(
    "Codex",
  );
});

test("rejects a stale save from a second browser tab", async ({ page, context }) => {
  const second = await context.newPage();
  for (const target of [page, second]) {
    await target.goto("/engineers");
    await target.locator('[data-testid="team-card"][data-role="inspection"] button').click();
  }
  await page.getByLabel("职责与工作方式", { exact: true }).fill("读取集群资源，并附带来源。");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByTestId("role-editor")).toHaveCount(0);
  await second.getByLabel("职责与工作方式", { exact: true }).fill("另一份过时的修改。");
  await second.getByRole("button", { name: "保存", exact: true }).click();
  await expect(second.getByRole("alert")).toContainText("其他");
  await expect(second.getByTestId("role-editor")).toBeVisible();
  await second.close();
});
