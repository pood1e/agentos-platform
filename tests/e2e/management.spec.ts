import { expect, test } from "@playwright/test";
import { resetKagent } from "./kagent.js";

test.beforeEach(async ({ request }) => resetKagent(request));

test("manages gateway model and MCP connections", async ({ page }) => {
  await page.goto("/engineers/models");
  await expect(page.getByTestId("connection-row")).toHaveCount(1);
  await page.getByRole("button", { name: "新增", exact: true }).click();
  const editor = page.getByTestId("connection-editor");
  await editor.locator("#connection-name").fill("browser-model");
  await editor.getByRole("textbox", { name: /^模型名称/ }).fill("gpt-6.1-sol-browser");
  await editor.getByLabel("访问密钥", { exact: true }).fill("browser-provider-secret");
  await editor.getByRole("button", { name: "保存", exact: true }).click();
  await expect(editor).toHaveCount(0);
  const model = page.getByTestId("connection-row").filter({ hasText: "browser-model" });
  await model.getByRole("button", { name: "编辑", exact: true }).click();
  await expect(editor.getByLabel("访问密钥", { exact: true })).toHaveValue("");
  await editor.getByRole("textbox", { name: /^服务地址/ }).fill("https://provider.example/v1");
  await editor.getByRole("button", { name: "保存", exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(model).toContainText("https://provider.example/v1");
  await model.getByRole("button", { name: "删除", exact: true }).click();
  await page.getByRole("button", { name: "确认", exact: true }).click();
  await expect(model).toHaveCount(0);
  await page.goto("/engineers/mcp");
  const builtins = page.getByTestId("connection-row").filter({ hasText: "部署托管" });
  await expect(builtins).toHaveCount(2);
  await expect(builtins.filter({ hasText: "团队协作" })).toHaveCount(1);
  await expect(builtins.filter({ hasText: "会话与工作空间" })).toHaveCount(1);
  for (const row of await builtins.all()) {
    await expect(row.getByRole("button", { name: "删除", exact: true })).toBeDisabled();
  }
  await builtins.first().getByRole("button", { name: "编辑", exact: true }).click();
  await expect(editor.locator("#connection-label")).toBeDisabled();
  await expect(editor.getByRole("button", { name: "保存", exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "新增", exact: true }).click();
  await editor.locator("#connection-name").fill("browser-mcp");
  await editor.getByRole("textbox", { name: /^主机名/ }).fill("mcp.example");
  await editor.getByRole("button", { name: "保存", exact: true }).click();
  await expect(editor).toHaveCount(0);
  const mcp = page.getByTestId("connection-row").filter({ hasText: "browser mcp" });
  await expect(mcp).toContainText("mcp.example:8080/mcp");
  await mcp.getByRole("button", { name: "删除", exact: true }).click();
  await page.getByRole("button", { name: "确认", exact: true }).click();
  await expect(mcp).toHaveCount(0);
});

test("reuses a catalog skill in an engineer and keeps its binding after catalog deletion", async ({
  page,
}) => {
  await page.goto("/engineers/skills");
  await page.getByRole("button", { name: "新增", exact: true }).click();
  await page.getByLabel("技能名称", { exact: true }).fill("browser-triage");
  await page
    .getByLabel("镜像地址（含 SHA-256）", { exact: true })
    .fill(`registry.example/triage@sha256:${"a".repeat(64)}`);
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByTestId("skill-row")).toContainText("browser-triage");
  await page.goto("/engineers");
  await page.locator('[data-testid="team-card"][data-role="inspection"] button').click();
  const editor = page.getByTestId("role-editor");
  await editor.getByRole("tab", { name: "技能", exact: true }).click();
  await editor.getByRole("button", { name: "从共享目录选择", exact: true }).click();
  await page.getByRole("button", { name: "browser-triage", exact: true }).click();
  await expect(editor.getByLabel("技能名称", { exact: true })).toHaveValue("browser-triage");
  await editor.getByRole("button", { name: "保存", exact: true }).click();
  await expect(editor).toHaveCount(0);
  await page.goto("/engineers/skills");
  await expect(page.getByTestId("skill-row")).toContainText("巡检");
  await page.getByRole("button", { name: "删除", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("仍会保留");
  await page.getByRole("button", { name: "确认", exact: true }).click();
  await expect(page.getByTestId("skill-row")).toHaveCount(0);
  await page.goto("/engineers");
  await page.locator('[data-testid="team-card"][data-role="inspection"] button').click();
  await editor.getByRole("tab", { name: "技能", exact: true }).click();
  await expect(editor.getByLabel("技能名称", { exact: true })).toHaveValue("browser-triage");
});

test("adds, semantically retrieves and explicitly clears native knowledge", async ({ page }) => {
  await page.goto("/engineers/knowledge");
  await expect(page.getByRole("heading", { name: /团队知识/ })).toBeVisible();
  await page.getByRole("button", { name: "新增", exact: true }).click();
  await page.getByLabel("知识内容", { exact: true }).fill("节点排空操作必须先获得用户审批。");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByTestId("knowledge-row")).toContainText("用户审批");
  await page.getByRole("textbox", { name: "搜索…", exact: true }).fill("排空节点");
  await page.getByRole("button", { name: "语义检索", exact: true }).click();
  await expect(page.getByTestId("knowledge-row")).toContainText("90%");
  await page.getByTestId("knowledge-row").getByRole("button").first().click();
  await expect(page.getByRole("dialog")).toContainText("节点排空操作必须先获得用户审批");
  await page.keyboard.press("Escape");
  await page.getByRole("textbox", { name: "搜索…", exact: true }).fill("");
  await expect(page.getByTestId("knowledge-row")).toHaveCount(1);
  await page.getByRole("button", { name: "清空知识", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("全部 1 条知识");
  await page.getByRole("button", { name: "确认", exact: true }).click();
  await expect(page.getByTestId("knowledge-row")).toHaveCount(0);
});

test("deletes one shared record from semantic results while preserving other knowledge", async ({
  page,
}) => {
  await page.goto("/engineers/knowledge");
  for (const content of ["需删除的巡检经验", "保留的诊断经验"]) {
    await page.getByRole("button", { name: "新增", exact: true }).click();
    await page.getByLabel("知识内容", { exact: true }).fill(content);
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.getByTestId("knowledge-row").filter({ hasText: content })).toBeVisible();
  }
  await page.getByRole("textbox", { name: "搜索…", exact: true }).fill("经验");
  await page.getByRole("button", { name: "语义检索", exact: true }).click();
  const selected = page.getByTestId("knowledge-row").filter({ hasText: "需删除的巡检经验" });
  await selected.getByRole("button", { name: "删除知识", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("需删除的巡检经验");
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await expect(page.getByTestId("knowledge-row")).toHaveCount(2);
  await selected.getByRole("button", { name: "删除知识", exact: true }).click();
  await page.getByRole("button", { name: "确认", exact: true }).click();
  await expect(selected).toHaveCount(0);
  await expect(page.getByTestId("knowledge-row")).toContainText("保留的诊断经验");
  await page.getByRole("button", { name: "返回全部知识", exact: true }).click();
  await page.getByRole("textbox", { name: "搜索…", exact: true }).fill("");
  await page.reload();
  await expect(page.getByTestId("knowledge-row")).toHaveCount(1);
  await expect(page.getByTestId("knowledge-row")).toContainText("保留的诊断经验");
});

test("management navigation remains usable in English on a small dark viewport", async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem("agentos-language", "en");
    localStorage.setItem("agentos-theme", "dark");
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/engineers/models");
  await page.getByRole("button", { name: "Main navigation", exact: true }).click();
  await expect(page.getByRole("link", { name: "Models", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await page.getByRole("link", { name: "Models", exact: true }).click();
  await expect(page.getByRole("heading", { name: /Models/ })).toBeVisible();
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(
    page.getByTestId("connection-editor").getByRole("textbox", { name: /^Model name/ }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "保存", exact: true })).toHaveCount(0);
});
