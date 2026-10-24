import { expect, test } from "@playwright/test";
import { resetKagent } from "./kagent.js";

test.beforeEach(async ({ request }) => resetKagent(request));

test("manages ASR and TTS independently through the shared model page", async ({ page }) => {
  await page.goto("/engineers/models");
  await page.getByRole("tab", { name: "语音模型", exact: true }).click();
  const asr = page.getByTestId("speech-transcription");
  const tts = page.getByTestId("speech-synthesis");
  await expect(asr).toContainText("未配置");
  await asr.getByRole("button").click();
  const editor = page.getByTestId("speech-editor");
  await editor.getByRole("checkbox", { name: "启用", exact: true }).check();
  await editor.getByRole("textbox", { name: /^服务地址/ }).fill("https://asr.example/v1");
  await editor.getByRole("textbox", { name: /^模型/ }).fill("qwen3-asr-1.7b");
  await editor.getByLabel("访问密钥", { exact: true }).fill("browser-asr-secret");
  await editor.getByRole("button", { name: "保存", exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(asr).toContainText("qwen3-asr-1.7b");
  await expect(asr).toContainText("凭据已配置");
  await tts.getByRole("button").click();
  await editor.getByRole("checkbox", { name: "启用", exact: true }).check();
  await editor.getByRole("textbox", { name: /^服务地址/ }).fill("https://tts.example/v1");
  await editor.getByRole("textbox", { name: /^模型/ }).fill("magpie");
  await editor.getByRole("textbox", { name: /^音色/, exact: false }).fill("Aria");
  await editor.getByRole("button", { name: "保存", exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(tts).toContainText("magpie");
  await asr.getByRole("button").click();
  await expect(editor.getByLabel("访问密钥", { exact: true })).toHaveValue("");
  await editor.getByRole("checkbox", { name: "启用", exact: true }).uncheck();
  await editor.getByRole("button", { name: "保存", exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(asr).toContainText("未配置");
  await expect(tts).toContainText("magpie");
  await page.reload();
  await expect(tts).toContainText("magpie");
});

test("offers a usable English speech editor on mobile", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("agentos-language", "en"));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/engineers/models?type=speech");
  await page.getByTestId("speech-transcription").getByRole("button").click();
  const editor = page.getByTestId("speech-editor");
  await editor.getByRole("checkbox", { name: "Enabled", exact: true }).check();
  await expect(editor.getByRole("textbox", { name: /^Service URL/ })).toBeVisible();
  await expect(editor.getByRole("button", { name: "Save", exact: true })).toBeVisible();
  await expect(page.getByText("Speech Transcription", { exact: true })).toHaveCount(0);
});

test("shows embedding connections separately and restores their tab after reload", async ({
  page,
}) => {
  await page.goto("/engineers/models");
  await expect(
    page.getByTestId("connection-row").filter({ hasText: "knowledge-embedding" }),
  ).toHaveCount(0);
  await page.getByRole("tab", { name: "向量模型", exact: true }).click();
  const row = page.getByTestId("connection-row").filter({ hasText: "knowledge-embedding" });
  await expect(row).toContainText("embeddinggemma:300m");
  await expect(row).toContainText("https://provider.example/v1");
  await expect(
    page.getByTestId("connection-row").filter({ hasText: "default-model-config" }),
  ).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("tab", { name: "向量模型", exact: true })).toHaveAttribute(
    "data-state",
    "active",
  );
  await expect(row).toBeVisible();
});
