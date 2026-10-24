import { expect, test } from "@playwright/test";
import { identityToken, testToken } from "../fixtures/identity.js";
import { resetKagent } from "./kagent.js";

const token = await identityToken([], "reader-test");
test.use({ extraHTTPHeaders: { authorization: `Bearer ${token}` } });
test.beforeEach(async ({ request }) => resetKagent(request));

test("lets a reader query through a new conversation", async ({ page }) => {
  await page.goto("/chat");
  await expect(page.getByRole("button", { name: "新聊天", exact: true })).toBeEnabled();
  await page.getByRole("textbox", { name: "消息", exact: true }).fill("你好，说明一下如何协作");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page).toHaveURL(/\/chat\/[^/]+/);
  await expect(page.getByTestId("chat-message")).toHaveCount(2);
  await page.reload();
  await expect(page.getByRole("textbox", { name: "消息", exact: true })).toBeVisible();
});

test("hides another user's operations and approval payloads", async ({ page }) => {
  await page.goto("/chat");
  await expect(page.getByRole("link", { name: "任务", exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "系统任务", exact: true })).toHaveCount(0);
  await page.goto("/chat?task=01a130a5-2363-76a6-8971-98a1a6459036");
  await expect(page.getByTestId("approval-detail")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "批准并继续", exact: true })).toHaveCount(0);
});

test("lets readers browse shared resource details without management controls", async ({
  page,
  request,
}) => {
  const headers = { authorization: `Bearer ${testToken}`, origin: "http://127.0.0.1:8090" };
  const skill = {
    name: "reader-visible-skill",
    oci: `registry.example/reader@sha256:${"a".repeat(64)}`,
  };
  expect(
    (
      await request.post("/agentos.management.v1.ManagementService/SaveSkill", {
        headers,
        data: { create: true, item: { skill, description: "Shared runbook" } },
      })
    ).ok(),
  ).toBe(true);
  expect(
    (
      await request.post("/agentos.management.v1.ManagementService/AddKnowledge", {
        headers,
        data: { content: "# Shared operations note\n\nDrain nodes after approval." },
      })
    ).ok(),
  ).toBe(true);
  const configuration = await (
    await request.post("/agentos.console.v1.ConsoleService/GetConfiguration", { data: {} })
  ).json();
  const role = configuration.roles.find((item: { name: string }) => item.name === "inspection");
  expect(role).toBeTruthy();
  role.skills = [skill];
  expect(
    (
      await request.post("/agentos.console.v1.ConsoleService/UpdateRole", {
        headers,
        data: { role },
      })
    ).ok(),
  ).toBe(true);
  const speech = await (
    await request.post("/agentos.management.v1.ManagementService/GetSpeechConfiguration", {
      data: {},
    })
  ).json();
  expect(
    (
      await request.post("/agentos.management.v1.ManagementService/SaveSpeechConfiguration", {
        headers,
        data: {
          resourceVersion: speech.resourceVersion,
          configuration: {
            transcription: {
              endpoint: { baseUrl: "https://asr.example/v1" },
              model: "large-v3",
              protocol: "PROTOCOL_WHISPERLIVEKIT",
              languageCodes: ["zh", "en", "ar"],
            },
          },
        },
      })
    ).ok(),
  ).toBe(true);
  const mutations: string[] = [];
  page.on("request", (request) => {
    if (
      /\/(?:SaveConnection|DeleteConnection|SaveSkill|DeleteSkill|SaveHarness|DeleteHarness|SetEngineerRuntime|CreateRole|UpdateRole|AddKnowledge|DeleteKnowledge|ClearKnowledge|SaveSpeechConfiguration)$/.test(
        new URL(request.url()).pathname,
      )
    )
      mutations.push(request.url());
  });
  await page.goto("/engineers");
  await expect(page.getByTestId("advanced")).toBeVisible();
  for (const path of [
    "/engineers",
    "/engineers/skills",
    "/engineers/mcp",
    "/engineers/models",
    "/engineers/harnesses",
    "/engineers/knowledge",
  ])
    await expect(page.locator(`nav a[href="${path}"]`)).toBeVisible();
  await expect(page.locator('nav a[href="/engineers/evaluation"]')).toHaveCount(0);
  await expect(page.getByRole("button", { name: "新增智能体", exact: true })).toHaveCount(0);
  await page
    .locator('[data-testid="team-card"][data-role="inspection"]')
    .getByRole("button", { name: "查看", exact: true })
    .click();
  const roleEditor = page.getByTestId("role-editor");
  await expect(roleEditor.locator("#role-prompt")).not.toBeEditable();
  await expect(roleEditor.getByTestId("role-builder")).toHaveCount(0);
  await roleEditor.getByRole("tab", { name: "技能", exact: true }).click();
  await expect(roleEditor.getByLabel("技能名称", { exact: true })).toHaveValue(skill.name);
  await expect(roleEditor.getByLabel("技能名称", { exact: true })).not.toBeEditable();
  await expect(roleEditor.getByRole("button", { name: "从共享目录选择", exact: true })).toHaveCount(
    0,
  );
  await roleEditor.getByRole("tab", { name: "工具", exact: true }).click();
  for (const checkbox of await roleEditor.getByRole("checkbox").all())
    await expect(checkbox).toBeDisabled();
  await roleEditor.getByRole("tab", { name: "运行时", exact: true }).click();
  await expect(roleEditor.getByRole("combobox", { name: "Harness", exact: true })).toBeDisabled();
  await expect(roleEditor.getByRole("button", { name: "应用运行时", exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  for (const [path, row, editor] of [
    ["/engineers/skills", "skill-row", ""],
    ["/engineers/mcp", "connection-row", "connection-editor"],
    ["/engineers/models", "connection-row", "connection-editor"],
    ["/engineers/harnesses", "harness-row", "harness-editor"],
  ]) {
    await page.goto(path);
    await expect(page.getByTestId("advanced")).toBeVisible();
    await expect(page.getByRole("button", { name: "新增", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "删除", exact: true })).toHaveCount(0);
    await page.getByTestId(row).first().getByRole("button", { name: "查看", exact: true }).click();
    const details = editor ? page.getByTestId(editor) : page.getByRole("dialog");
    await expect(details).toBeVisible();
    await expect(details.getByRole("button", { name: "保存", exact: true })).toHaveCount(0);
    await expect(details.getByLabel("访问密钥", { exact: true })).toHaveCount(0);
    for (const input of await details.locator('input:not([type="hidden"]), textarea').all())
      await expect(input).not.toBeEditable();
    await page.keyboard.press("Escape");
  }
  await page.goto("/engineers/models?type=speech");
  await expect(page.getByTestId("speech-models")).toBeVisible();
  await expect(page.getByRole("button", { name: "新增接入", exact: true })).toHaveCount(0);
  await page
    .getByTestId("speech-transcription")
    .getByRole("button", { name: "查看", exact: true })
    .click();
  const speechEditor = page.getByTestId("speech-editor");
  await expect(speechEditor.getByRole("textbox", { name: /^模型/ })).toHaveValue("large-v3");
  await expect(speechEditor.getByRole("textbox", { name: /^模型/ })).not.toBeEditable();
  await expect(speechEditor.locator('button[type="submit"]')).toHaveCount(0);
  await expect(speechEditor.getByLabel("访问密钥", { exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.goto("/engineers/knowledge");
  await expect(page.getByRole("button", { name: "新增", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "清空知识", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "删除知识", exact: true })).toHaveCount(0);
  await page.getByTestId("knowledge-row").getByRole("button").click();
  await expect(page.getByRole("dialog")).toContainText("Drain nodes after approval");
  await page.keyboard.press("Escape");
  await page.getByRole("textbox", { name: "搜索…", exact: true }).fill("Drain");
  await page.getByRole("button", { name: "语义检索", exact: true }).click();
  await expect(page.getByTestId("knowledge-row")).toContainText("90%");
  expect(mutations).toEqual([]);
});
