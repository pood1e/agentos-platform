import { type APIRequestContext, expect, test } from "@playwright/test";
import { client, resetKagent } from "./kagent.js";

const models = "http://127.0.0.1:8094/apis/api.kagent.dev/v1alpha3/namespaces/agentos/modelconfigs";
test.beforeEach(async ({ request }) => resetKagent(request));

async function configure(request: APIRequestContext, extraMessages = false) {
  const current = await (await request.get(`${models}/default-model-config`)).json();
  current.spec.openAI.maxCompletionTokens = 8192;
  expect((await request.put(`${models}/default-model-config`, { data: current })).ok()).toBe(true);
  const connections: [string, string, object][] = [
    [
      "responses-model",
      "OpenAI",
      { openAI: { apiFormat: "responses", baseUrl: "http://gateway/v1" } },
    ],
    ["messages-model", "Anthropic", { anthropic: { baseUrl: "http://gateway" } }],
  ];
  if (extraMessages)
    connections.push(["messages-other", "Anthropic", { anthropic: { baseUrl: "http://gateway" } }]);
  for (const [name, provider, protocol] of connections)
    expect(
      (
        await request.post(models, {
          data: {
            apiVersion: "api.kagent.dev/v1alpha3",
            kind: "ModelConfig",
            metadata: { name },
            spec: {
              provider,
              model: "test-model",
              apiKeySecret: "test",
              apiKeySecretKey: "api-key",
              ...protocol,
            },
          },
        })
      ).ok(),
    ).toBe(true);
}

test("selects compatible models and switches Claude and Codex in both directions", async ({
  page,
  request,
}) => {
  await configure(request);
  await page.goto("/engineers");
  await page.locator('[data-testid="team-card"][data-role="diagnosis"] button').click();
  const editor = page.getByTestId("role-editor");
  await editor.getByLabel("简介", { exact: true }).fill("Unsaved description");
  await editor.getByRole("tab", { name: "运行时", exact: true }).click();
  const runtime = editor.getByTestId("engineer-runtime");
  for (const [harness, model] of [
    ["Claude Code · Claude Code", "messages-model"],
    ["Codex · Codex", "responses-model"],
    ["Claude Code · Claude Code", "messages-model"],
  ]) {
    await runtime.getByRole("combobox", { name: "Harness", exact: true }).click();
    await page.getByRole("option", { name: harness, exact: true }).click();
    await expect(runtime.getByRole("combobox", { name: "模型接入", exact: true })).toHaveText(
      model,
    );
    await runtime.getByRole("button", { name: "应用运行时", exact: true }).click();
    await expect(runtime).toContainText("运行时已保存");
  }
  await editor.getByRole("tab", { name: "提示词", exact: true }).click();
  await expect(editor.getByLabel("简介", { exact: true })).toHaveValue("Unsaved description");
  await editor.getByRole("button", { name: "保存", exact: true }).click();
  await expect(editor).toHaveCount(0);
  await page.locator('[data-testid="team-card"][data-role="diagnosis"] button').click();
  await editor.getByRole("tab", { name: "运行时", exact: true }).click();
  await expect(runtime.getByRole("combobox", { name: "Harness", exact: true })).toContainText(
    "Claude Code",
  );
  await expect(runtime.getByRole("combobox", { name: "模型接入", exact: true })).toHaveText(
    "messages-model",
  );
});

test("requires an explicit choice when several compatible models are available", async ({
  page,
  request,
}) => {
  await configure(request, true);
  await page.goto("/engineers");
  await page.locator('[data-testid="team-card"][data-role="diagnosis"] button').click();
  const editor = page.getByTestId("role-editor");
  await editor.getByRole("tab", { name: "运行时", exact: true }).click();
  const runtime = editor.getByTestId("engineer-runtime");
  await runtime.getByRole("combobox", { name: "Harness", exact: true }).click();
  await page.getByRole("option", { name: "Claude Code · Claude Code", exact: true }).click();
  await expect(runtime.getByRole("button", { name: "应用运行时", exact: true })).toBeDisabled();
  await runtime.getByRole("combobox", { name: "模型接入", exact: true }).click();
  await expect(page.getByRole("option", { name: "default-model-config", exact: true })).toHaveCount(
    0,
  );
  await expect(page.getByRole("option", { name: "responses-model", exact: true })).toHaveCount(0);
  await page.getByRole("option", { name: "messages-other", exact: true }).click();
  await runtime.getByRole("button", { name: "应用运行时", exact: true }).click();
  await expect(runtime).toContainText("运行时已保存");
});

test("explains a missing compatible model before submission in English", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("agentos-language", "en"));
  await page.goto("/engineers");
  await page.locator('[data-testid="team-card"][data-role="diagnosis"] button').click();
  const editor = page.getByTestId("role-editor");
  await editor.getByRole("tab", { name: "Runtime", exact: true }).click();
  const runtime = editor.getByTestId("engineer-runtime");
  await runtime.getByRole("combobox", { name: "Harness", exact: true }).click();
  await page.getByRole("option", { name: "Claude Code · Claude Code", exact: true }).click();
  await expect(runtime).toContainText("No compatible connection");
  await expect(runtime.getByRole("button", { name: "Apply runtime", exact: true })).toBeDisabled();
});

test("saves Claude with a selected MCP tool subset without expanding the binding", async ({
  page,
  request,
}) => {
  await configure(request);
  const before = (await client.getConfiguration({})).roles.find(
    (role) => role.name === "inspection",
  )?.tools;
  await page.goto("/engineers");
  await page.locator('[data-testid="team-card"][data-role="inspection"] button').click();
  const editor = page.getByTestId("role-editor");
  await editor.getByRole("tab", { name: "运行时", exact: true }).click();
  const runtime = editor.getByTestId("engineer-runtime");
  await runtime.getByRole("combobox", { name: "Harness", exact: true }).click();
  await page.getByRole("option", { name: "Claude Code · Claude Code", exact: true }).click();
  await expect(runtime.getByRole("combobox", { name: "模型接入", exact: true })).toHaveText(
    "messages-model",
  );
  await runtime.getByRole("button", { name: "应用运行时", exact: true }).click();
  await expect(runtime).toContainText("运行时已保存");
  expect(
    (await client.getConfiguration({})).roles.find((role) => role.name === "inspection")?.tools,
  ).toEqual(before);
});
