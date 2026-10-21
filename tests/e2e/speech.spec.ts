import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { expect, test } from "@playwright/test";
import {
  SynthesizeSpeechRequestSchema,
  SynthesizeSpeechResponseSchema,
  TranscribeAudioRequestSchema,
  TranscribeAudioResponseSchema,
} from "../../gen/agentos/console/v1/speech_pb.js";
import { resetKagent } from "./kagent.js";

test.beforeEach(async ({ page, request }) => {
  await resetKagent(request);
  await page.addInitScript(() => {
    class Recorder extends EventTarget {
      static isTypeSupported() {
        return true;
      }
      mimeType = "audio/webm";
      state = "inactive";
      start() {
        this.state = "recording";
      }
      stop() {
        this.state = "inactive";
        queueMicrotask(() => {
          this.dispatchEvent(
            new BlobEvent("dataavailable", { data: new Blob(["test recording"]) }),
          );
          this.dispatchEvent(new Event("stop"));
        });
      }
    }
    Object.defineProperty(window, "MediaRecorder", { value: Recorder });
    Object.defineProperty(navigator, "mediaDevices", {
      value: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) },
    });
    class Player extends EventTarget {
      async play() {}
      pause() {}
      removeAttribute() {}
    }
    Object.defineProperty(window, "Audio", { value: Player });
  });
});

for (const transcription of [false, true])
  for (const synthesis of [false, true])
    test(`shows speech input=${transcription} and output=${synthesis} independently`, async ({
      page,
    }) => {
      await page.route("**/agentos.console.v1.ConsoleService/GetSpeechCapabilities", (route) =>
        route.fulfill({ json: { transcription, synthesis } }),
      );
      await page.goto("/chat");
      const input = page.getByRole("textbox", { name: "消息", exact: true });
      await input.fill("你好，语音能力验收");
      await page.getByRole("button", { name: "发送", exact: true }).click();
      await expect(page.getByTestId("chat-message")).toHaveCount(2);
      await expect(page.getByRole("button", { name: "语音输入", exact: true })).toHaveCount(
        transcription ? 1 : 0,
      );
      await expect(page.getByRole("button", { name: "朗读", exact: true })).toHaveCount(
        synthesis ? 1 : 0,
      );
      await expect(input).toBeEditable();
    });

test("dictates multilingual text into the existing composer and waits for the user to send", async ({
  page,
}) => {
  await page.route("**/agentos.console.v1.ConsoleService/GetSpeechCapabilities", (route) =>
    route.fulfill({ json: { transcription: true } }),
  );
  await page.route("**/agentos.console.v1.ConsoleService/TranscribeAudio", async (route) => {
    const request = fromBinary(
      TranscribeAudioRequestSchema,
      route.request().postDataBuffer() ?? new Uint8Array(),
    );
    expect(request.audio?.contentType).toBe("audio/webm");
    expect(request.audio?.data.length).toBeGreaterThan(0);
    await route.fulfill({
      contentType: "application/proto",
      body: Buffer.from(
        toBinary(
          TranscribeAudioResponseSchema,
          create(TranscribeAudioResponseSchema, {
            text: "检查交换机 / Check the switch / افحص المحول",
          }),
        ),
      ),
    });
  });
  await page.goto("/chat");
  await page.getByRole("button", { name: "语音输入", exact: true }).click();
  const input = page.getByRole("textbox", { name: "消息", exact: true });
  await expect(input).toBeDisabled();
  await page.getByRole("button", { name: "停止录音", exact: true }).click();
  await expect(input).toHaveValue("检查交换机 / Check the switch / افحص المحول");
  await expect(input).toBeEditable();
  await expect(page.getByTestId("chat-message")).toHaveCount(0);
  await input.fill("修正后的查询");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.getByTestId("chat-message")).toHaveCount(2);
});

test("reads an assistant answer with the official playback controls and stops on request", async ({
  page,
}) => {
  await page.route("**/agentos.console.v1.ConsoleService/GetSpeechCapabilities", (route) =>
    route.fulfill({ json: { synthesis: true } }),
  );
  await page.route("**/agentos.console.v1.ConsoleService/SynthesizeSpeech", async (route) => {
    const request = fromBinary(
      SynthesizeSpeechRequestSchema,
      route.request().postDataBuffer() ?? new Uint8Array(),
    );
    expect(request.text.length).toBeGreaterThan(0);
    await route.fulfill({
      contentType: "application/proto",
      body: Buffer.from(
        toBinary(
          SynthesizeSpeechResponseSchema,
          create(SynthesizeSpeechResponseSchema, {
            audio: { contentType: "audio/wav", data: new Uint8Array([1, 2, 3]) },
          }),
        ),
      ),
    });
  });
  await page.goto("/chat");
  await page.getByRole("textbox", { name: "消息", exact: true }).fill("你好");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await page.getByRole("button", { name: "朗读", exact: true }).click();
  await expect(page.getByRole("button", { name: "停止播放", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "停止播放", exact: true }).click();
  await expect(page.getByRole("button", { name: "朗读", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "停止播放", exact: true })).toHaveCount(0);
});

test("keeps text chat usable after the speech provider fails", async ({ page }) => {
  await page.route("**/agentos.console.v1.ConsoleService/GetSpeechCapabilities", (route) =>
    route.fulfill({ json: { transcription: true } }),
  );
  await page.route("**/agentos.console.v1.ConsoleService/TranscribeAudio", (route) =>
    route.fulfill({ status: 503, json: { code: "unavailable", message: "request failed" } }),
  );
  await page.goto("/chat");
  await page.getByRole("button", { name: "语音输入", exact: true }).click();
  await page.getByRole("button", { name: "停止录音", exact: true }).click();
  await expect(page.getByText("语音转写失败，请重试或输入文字。")).toBeVisible();
  const input = page.getByRole("textbox", { name: "消息", exact: true });
  await expect(input).toBeEditable();
  await input.fill("继续文字聊天");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.getByTestId("chat-message")).toHaveCount(2);
});
