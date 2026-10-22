import { readFileSync } from "node:fs";
import { create, fromBinary, fromJson, toBinary } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import { expect, test } from "@playwright/test";
import { ArtifactSchema, TaskState } from "../../gen/a2a_pb.js";
import {
  SynthesizeSpeechRequestSchema,
  SynthesizeSpeechResponseSchema,
} from "../../gen/agentos/console/v1/speech_pb.js";
import { partTypeKey } from "../../server/read-model/decode/messages.js";
import { ids, observeTask, recordedTask, resetKagent } from "./kagent.js";

function audioResponse() {
  const data = toBinary(
    SynthesizeSpeechResponseSchema,
    create(SynthesizeSpeechResponseSchema, {
      audio: { contentType: "audio/wav", data: new Uint8Array([1, 2, 3]) },
    }),
  );
  const header = Buffer.alloc(5);
  header.writeUInt32BE(data.length, 1);
  return Buffer.concat([header, data, Buffer.from([2, 0, 0, 0, 2]), Buffer.from("{}")]);
}

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
        queueMicrotask(() =>
          this.dispatchEvent(
            new BlobEvent("dataavailable", { data: new Blob(["streaming audio"]) }),
          ),
        );
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
    const microphone = new AudioContext().createMediaStreamDestination().stream;
    Object.defineProperty(navigator, "mediaDevices", {
      value: { getUserMedia: async () => microphone },
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
  await page.routeWebSocket("**/speech/v1/listen*", (socket) => {
    socket.onMessage((message) => {
      if (typeof message === "string") {
        expect(JSON.parse(message).type).toBe("CloseStream");
        socket.send(
          JSON.stringify({
            type: "Results",
            is_final: true,
            channel: {
              alternatives: [{ transcript: "检查交换机 / Check the switch / افحص المحول" }],
            },
          }),
        );
        socket.close({ code: 1000 });
      } else {
        socket.send(
          JSON.stringify({
            type: "Results",
            is_final: false,
            channel: { alternatives: [{ transcript: "检查交换机" }] },
          }),
        );
      }
    });
  });
  await page.goto("/chat");
  await page.getByRole("button", { name: "语音输入", exact: true }).click();
  const input = page.getByRole("textbox", { name: "消息", exact: true });
  await expect(input).toBeDisabled();
  await expect(input).toHaveValue("检查交换机");
  await expect(page.getByTestId("chat-message")).toHaveCount(0);
  await page.getByRole("button", { name: "停止录音", exact: true }).click();
  await expect(input).toHaveValue("检查交换机 / Check the switch / افحص المحول");
  await expect(input).toBeEditable();
  await expect(page.getByTestId("chat-message")).toHaveCount(0);
  await input.fill("修正后的查询");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.getByTestId("chat-message")).toHaveCount(2);
});

test("ends dictation after real speech and silence using the shipped Silero VAD", async ({
  page,
}) => {
  const wav = readFileSync("tests/fixtures/speech/zh.wav").toString("base64");
  await page.addInitScript(
    ({ wav }) => {
      const context = new AudioContext();
      const destination = context.createMediaStreamDestination();
      let source: AudioBufferSourceNode;
      navigator.mediaDevices.getUserMedia = async () => {
        const data = Uint8Array.from(atob(wav), (character) => character.charCodeAt(0));
        source = context.createBufferSource();
        source.buffer = await context.decodeAudioData(data.buffer);
        source.connect(destination);
        await context.resume();
        return destination.stream;
      };
      const start = MediaRecorder.prototype.start;
      MediaRecorder.prototype.start = function () {
        start.call(this);
        source.start();
      };
    },
    { wav },
  );
  await page.route("**/agentos.console.v1.ConsoleService/GetSpeechCapabilities", (route) =>
    route.fulfill({ json: { transcription: true } }),
  );
  let finalized = 0;
  await page.routeWebSocket("**/speech/v1/listen*", (socket) => {
    socket.onMessage((message) => {
      const final = typeof message === "string";
      if (final) finalized++;
      socket.send(
        JSON.stringify({
          type: "Results",
          is_final: final,
          channel: { alternatives: [{ transcript: final ? "尾字完整保留。" : "正在输入" }] },
        }),
      );
      if (final) socket.close({ code: 1000 });
    });
  });
  await page.goto("/chat");
  await page.getByRole("button", { name: "语音输入", exact: true }).click();
  await expect(page.getByRole("button", { name: "停止录音", exact: true })).toBeVisible();
  const started = Date.now();
  const input = page.getByRole("textbox", { name: "消息", exact: true });
  await expect(input).toHaveValue("尾字完整保留。", { timeout: 10_000 });
  expect(Date.now() - started).toBeLessThan(10_000);
  await expect(input).toBeEditable();
  expect(finalized).toBe(1);
  await expect(page.getByTestId("chat-message")).toHaveCount(0);
});

test("reads an assistant answer with the official playback controls and stops on request", async ({
  page,
}) => {
  await page.route("**/agentos.console.v1.ConsoleService/GetSpeechCapabilities", (route) =>
    route.fulfill({ json: { transcription: true, synthesis: true } }),
  );
  await page.route("**/agentos.console.v1.ConsoleService/SynthesizeSpeech", async (route) => {
    const request = fromBinary(
      SynthesizeSpeechRequestSchema,
      route.request().postDataBuffer()?.subarray(5) ?? new Uint8Array(),
    );
    expect(request.text.length).toBeGreaterThan(0);
    await route.fulfill({
      contentType: "application/connect+proto",
      body: audioResponse(),
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
  await page.routeWebSocket("**/speech/v1/listen*", (socket) => {
    socket.onMessage(() => {});
  });
  await page.getByRole("button", { name: "朗读", exact: true }).click();
  await expect(page.getByRole("button", { name: "停止播放", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "语音输入", exact: true }).click();
  await expect(page.getByRole("button", { name: "停止录音", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "停止播放", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "朗读", exact: true }).click();
  await expect(page.getByRole("button", { name: "停止录音", exact: true })).toHaveCount(0);
});

test("speaks only the completed answer and preserves visible progress across tools and reloads", async ({
  page,
  request,
}) => {
  await page.route("**/agentos.console.v1.ConsoleService/GetSpeechCapabilities", (route) =>
    route.fulfill({ json: { synthesis: true } }),
  );
  const spoken: string[] = [];
  await page.route("**/agentos.console.v1.ConsoleService/SynthesizeSpeech", async (route) => {
    spoken.push(
      fromBinary(
        SynthesizeSpeechRequestSchema,
        route.request().postDataBuffer()?.subarray(5) ?? new Uint8Array(),
      ).text,
    );
    await route.fulfill({ contentType: "application/connect+proto", body: audioResponse() });
  });
  const task = await recordedTask(request, ids.chat);
  task.artifacts = [
    create(ArtifactSchema, {
      artifactId: "progress",
      parts: [{ content: { case: "text", value: "先调用 MCP 检查当前资源。" } }],
    }),
  ];
  if (task.status) task.status.state = TaskState.WORKING;
  await observeTask(request, task);
  await page.goto(`/chat/${task.contextId}`);
  const answer = page.getByTestId("chat-message").filter({ hasText: "先调用 MCP 检查当前资源。" });
  await expect(answer).toBeVisible();
  await expect(page.getByRole("button", { name: "朗读", exact: true })).toHaveCount(0);
  for (const kind of ["function_call", "function_response"])
    task.artifacts.push(
      create(ArtifactSchema, {
        artifactId: kind,
        parts: [
          {
            metadata: { [partTypeKey]: kind },
            content: {
              case: "data",
              value: fromJson(ValueSchema, {
                id: "speech-check",
                name: "k8s_get_resources",
                args: { namespace: "operations" },
                response: { output: "raw-tool-payload" },
              }),
            },
          },
        ],
      }),
    );
  task.artifacts.push(
    create(ArtifactSchema, {
      artifactId: "final",
      parts: [
        {
          content: {
            case: "text",
            value:
              '# 检查结果\n\n**所有资源健康。**\n\n```json\n{"tool":"k8s_get_resources","result":"raw-tool-payload"}\n```\n\n| Tool | Result |\n|---|---|\n| k8s_get_resources | raw-tool-payload |\n\n[查看报告](https://example.test/report)',
          },
        },
      ],
    }),
  );
  await observeTask(request, task);
  await expect(answer).toContainText("所有资源健康。");
  await expect(page.getByRole("button", { name: "朗读", exact: true })).toHaveCount(0);
  if (task.status) task.status.state = TaskState.COMPLETED;
  await observeTask(request, task);
  const call = answer.getByTestId("chat-tool-call");
  await expect(call).toHaveCount(1);
  await call.getByRole("button").click();
  await expect(call.getByTestId("call-output")).toContainText("raw-tool-payload");
  await answer.getByRole("button", { name: "朗读", exact: true }).click();
  await expect.poll(() => spoken).toEqual(["检查结果\n\n所有资源健康。\n\n查看报告"]);
  await page.reload();
  await expect(answer).toContainText("所有资源健康。");
  await answer.getByRole("button", { name: "朗读", exact: true }).click();
  await expect.poll(() => spoken).toEqual(Array(2).fill("检查结果\n\n所有资源健康。\n\n查看报告"));
  await page.getByRole("button", { name: "停止播放", exact: true }).click();
  task.artifacts = [
    create(ArtifactSchema, {
      artifactId: "code-only",
      parts: [{ content: { case: "text", value: '```json\n{"tool":"k8s_get_resources"}\n```' } }],
    }),
  ];
  await observeTask(request, task);
  await expect(page.getByTestId("chat-message").last()).toContainText("k8s_get_resources");
  await expect(page.getByRole("button", { name: "朗读", exact: true })).toHaveCount(0);
});

test("keeps text chat usable after the speech provider fails", async ({ page }) => {
  await page.route("**/agentos.console.v1.ConsoleService/GetSpeechCapabilities", (route) =>
    route.fulfill({ json: { transcription: true } }),
  );
  await page.routeWebSocket("**/speech/v1/listen*", (socket) => {
    socket.onMessage(() => socket.close({ code: 1011 }));
  });
  await page.goto("/chat");
  await page.getByRole("button", { name: "语音输入", exact: true }).click();
  await expect(page.getByText("语音转写失败，请重试或输入文字。")).toBeVisible();
  const input = page.getByRole("textbox", { name: "消息", exact: true });
  await expect(input).toBeEditable();
  await input.fill("继续文字聊天");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.getByTestId("chat-message")).toHaveCount(2);
});

test("selects a speech language and cancels final processing while preserving the editable draft", async ({
  page,
}) => {
  await page.route("**/agentos.console.v1.ConsoleService/GetSpeechCapabilities", (route) =>
    route.fulfill({ json: { transcription: true, transcriptionLanguages: ["zh", "en", "ar"] } }),
  );
  await page.routeWebSocket("**/speech/v1/listen*", (socket) => {
    expect(new URL(socket.url()).searchParams.get("language")).toBe("ar");
    socket.onMessage((message) => {
      if (typeof message !== "string")
        socket.send(
          JSON.stringify({
            type: "Results",
            is_final: false,
            channel: { alternatives: [{ transcript: "مرحبا" }] },
          }),
        );
    });
  });
  await page.goto("/chat");
  await page.getByRole("combobox", { name: "识别语言" }).click();
  await page.getByRole("option", { name: "阿拉伯语", exact: true }).click();
  await page.getByRole("button", { name: "语音输入", exact: true }).click();
  const input = page.getByRole("textbox", { name: "消息", exact: true });
  await expect(input).toHaveValue("مرحبا");
  await expect(page.getByRole("status").filter({ hasText: "正在聆听" })).toBeVisible();
  await page.getByRole("button", { name: "停止录音", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "正在处理尾部语音" })).toBeVisible();
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await expect(input).toBeEditable();
  await expect(input).toHaveValue("مرحبا");
  await expect(page.getByTestId("chat-message")).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("combobox", { name: "识别语言" })).toContainText("阿拉伯语");
});
