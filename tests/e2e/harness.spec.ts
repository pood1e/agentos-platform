import { expect, test } from "@playwright/test";
import { resetKagent } from "./kagent.js";

test.beforeEach(async ({ request }) => resetKagent(request));

test("assigns Codex per engineer and retains the chosen runtime after reopening", async ({
  page,
}) => {
  await page.goto("/engineers");
  await page.locator('[data-testid="team-card"][data-role="inspection"] button').click();
  const editor = page.getByTestId("role-editor");
  await editor.getByRole("tab", { name: "运行时", exact: true }).click();
  const runtime = editor.getByTestId("engineer-runtime");
  await runtime.getByRole("combobox", { name: "Harness", exact: true }).click();
  await page.getByRole("option", { name: "Codex · Codex", exact: true }).click();
  await runtime.getByRole("button", { name: "应用运行时", exact: true }).click();
  await expect(runtime).toContainText("运行时已保存");
  for (const choice of ["标准运行时 · kagent", "Codex · Codex"]) {
    await runtime.getByRole("combobox", { name: "Harness", exact: true }).click();
    await page.getByRole("option", { name: choice, exact: true }).click();
    await runtime.getByRole("button", { name: "应用运行时", exact: true }).click();
    await expect(runtime).toContainText("运行时已保存");
  }
  await page.keyboard.press("Escape");
  await page.locator('[data-testid="team-card"][data-role="inspection"] button').click();
  await editor.getByRole("tab", { name: "运行时", exact: true }).click();
  await expect(runtime.getByRole("combobox", { name: "Harness", exact: true })).toContainText(
    "Codex",
  );
  await page.keyboard.press("Escape");
  await page.locator('[data-testid="team-card"][data-role="coordinator"] button').click();
  await editor.getByRole("tab", { name: "运行时", exact: true }).click();
  await expect(runtime.getByRole("combobox", { name: "Harness", exact: true })).toContainText(
    "标准运行时",
  );
});

test("creates, edits and deletes a custom BYO Harness with the native schema form", async ({
  page,
}) => {
  await page.goto("/engineers/harnesses");
  await expect(page.getByTestId("harness-row")).toHaveCount(4);
  await page.getByRole("button", { name: "新增", exact: true }).click();
  const editor = page.getByTestId("harness-editor");
  await editor.locator("#harness-name").fill("browser-byo");
  await editor
    .getByRole("textbox", { name: /^镜像（含 SHA256）/ })
    .fill(`registry.example/engineer@sha256:${"a".repeat(64)}`);
  await editor.locator("#root_workload_command__add").click();
  await editor.locator("#root_workload_command_0").fill("/engineer");
  await editor.getByRole("button", { name: "保存", exact: true }).click();
  await expect(editor).toHaveCount(0);
  const row = page.locator('[data-testid="harness-row"][data-harness="browser-byo"]');
  await expect(row).toContainText("BYO");
  await row.getByRole("button", { name: "配置", exact: true }).click();
  await expect(editor.locator("#root_workload_command_0")).toHaveValue("/engineer");
  await editor.getByRole("button", { name: "保存", exact: true }).click();
  await expect(editor).toHaveCount(0);
  await row.getByRole("button", { name: "删除", exact: true }).click();
  await page.getByRole("button", { name: "确认", exact: true }).click();
  await expect(row).toHaveCount(0);
});

test("retains preset kagent memory settings when the native Harness is edited", async ({
  page,
}) => {
  await page.goto("/engineers/harnesses");
  const row = page.locator('[data-testid="harness-row"][data-harness="memory"]');
  await expect(row.getByRole("button", { name: "删除", exact: true })).toBeDisabled();
  await row.getByRole("button", { name: "配置", exact: true }).click();
  const editor = page.getByTestId("harness-editor");
  await expect(editor.locator("#root_kagent_memory_modelConfigRef_name")).toHaveValue(
    "knowledge-embedding",
  );
  await editor.getByRole("button", { name: "保存", exact: true }).click();
  await expect(editor).toHaveCount(0);
});

test("configures Harness model protocols and clears incompatible request options", async ({
  page,
}) => {
  await page.goto("/engineers/models");
  await page.getByRole("button", { name: "新增", exact: true }).click();
  const editor = page.getByTestId("connection-editor");
  await editor.locator("#connection-name").fill("browser-runtime-model");
  await editor.getByRole("textbox", { name: /^模型名称/ }).fill("runtime-model");
  await editor.getByRole("combobox", { name: "调用接口", exact: true }).click();
  await page.getByRole("option", { name: "Responses", exact: true }).click();
  await editor.getByRole("button", { name: "请求参数", exact: true }).click();
  await editor.locator("#model-token-limit").fill("8192");
  await editor.locator("#model-reasoning").fill("medium");
  await editor.getByRole("button", { name: "保存", exact: true }).click();
  await expect(editor).toHaveCount(0);
  const row = page.getByTestId("connection-row").filter({ hasText: "browser-runtime-model" });
  await row.getByRole("button", { name: "编辑", exact: true }).click();
  await editor.getByRole("button", { name: "请求参数", exact: true }).click();
  await expect(editor.locator("#model-token-limit")).toHaveValue("8192");
  await editor.locator("#model-token-limit").fill("");
  await editor.locator("#model-reasoning").fill("");
  await editor.getByRole("button", { name: "保存", exact: true }).click();
  await expect(editor).toHaveCount(0);
  await row.getByRole("button", { name: "编辑", exact: true }).click();
  await editor.getByRole("button", { name: "请求参数", exact: true }).click();
  await expect(editor.locator("#model-token-limit")).toHaveValue("");
  await expect(editor.locator("#model-reasoning")).toHaveValue("");
  await editor.getByRole("combobox", { name: "调用接口", exact: true }).click();
  await page.getByRole("option", { name: "Anthropic Messages", exact: true }).click();
  await editor.getByRole("button", { name: "保存", exact: true }).click();
  await expect(editor).toHaveCount(0);
  await row.getByRole("button", { name: "编辑", exact: true }).click();
  await expect(editor.getByRole("combobox", { name: "调用接口", exact: true })).toContainText(
    "Anthropic Messages",
  );
});
