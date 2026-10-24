import { create, fromJson, type JsonValue } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import { expect, test } from "@playwright/test";
import { ArtifactSchema, PartSchema, TaskState } from "../../gen/a2a_pb.js";
import { partTypeKey } from "../../server/read-model/decode/messages.js";
import {
  decideApproval,
  ids,
  observeTask,
  recordedTask,
  resetKagent,
  startOperation,
} from "./kagent.js";

test.beforeEach(async ({ request }) => resetKagent(request));

test("ordinary chat keeps its history and has no operational task", async ({ page }) => {
  await page.goto("/chat");
  const input = page.getByRole("textbox", { name: "消息", exact: true });
  await expect(page.getByRole("button", { name: "发送", exact: true })).toBeDisabled();
  await input.fill("你好，说明一下如何协作");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page).toHaveURL(/\/chat\/[^/]+$/);
  await expect(page.getByTestId("chat-message")).toHaveCount(2);
  await expect(page.getByTestId("chat-task")).toHaveCount(0);
  await expect(page.getByTestId("chat-task-panel")).toHaveCount(0);
  const url = page.url();
  await page.reload();
  await expect(page.getByTestId("chat-message")).toHaveCount(2);
  await page.goto("/");
  await expect(page).toHaveURL(url);
});

test("does not replace the current chat when a previous send finishes after navigating back", async ({
  page,
}) => {
  await page.goto("/chat");
  await page.getByRole("textbox", { name: "消息", exact: true }).fill("保留当前会话");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page).toHaveURL(/\/chat\/[^/?]+$/);
  await expect(page.getByTestId("chat-message").last()).toContainText("已处理：保留当前会话");
  const original = page.url();
  await page.getByRole("button", { name: "新聊天", exact: true }).click();
  await expect(page).toHaveURL(/\/chat$/);
  await expect(page.getByTestId("chat-message")).toHaveCount(0);
  let release = () => {};
  let accepted = () => {};
  const ready = new Promise<void>((resolve) => {
    accepted = resolve;
  });
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/agentos.console.v1.ConsoleService/SendMessage", async (route) => {
    const response = await route.fetch();
    accepted();
    await hold;
    await route.fulfill({ response });
  });
  await page.getByRole("textbox", { name: "消息", exact: true }).fill("延迟返回的另一个会话");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await ready;
  try {
    await page.goBack();
    await expect(page).toHaveURL(original);
    await expect(page.getByTestId("chat-message").last()).toContainText("已处理：保留当前会话");
  } finally {
    release();
  }
  await page.getByRole("textbox", { name: "消息", exact: true }).fill("仍在原会话编辑");
  await expect(page.getByRole("button", { name: "发送", exact: true })).toBeEnabled();
  await expect(page).toHaveURL(original);
  await expect(page.getByTestId("chat-message")).toHaveCount(2);
  await expect(page.getByTestId("conversation")).not.toContainText("延迟返回的另一个会话");
});

test("keeps chat full width and shows delegated workers without task details", async ({ page }) => {
  await startOperation(page);
  await expect(page.getByTestId("chat-task-panel")).toHaveCount(0);
  await expect(page.getByTestId("chat-working-agents")).toBeVisible();
  await expect(page.getByTestId("chat-working-agent")).not.toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "消息", exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("chat-working-agents")).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("compact-chat-delegation-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId("conversation")).toBeVisible();
  await expect(page.getByTestId("chat-working-agents")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: test.info().outputPath("compact-chat-delegation-mobile.png") });
  await page.getByRole("button", { name: "聊天记录", exact: true }).click();
  await page.getByRole("button", { name: "新聊天", exact: true }).click();
  await expect(page.getByTestId("chat-working-agents")).toHaveCount(0);
});

test("keeps streamed text visible while tools run, after completion and after reloading the chat", async ({
  page,
  request,
}) => {
  const task = await recordedTask(request, ids.chat);
  task.artifacts = [
    create(ArtifactSchema, {
      artifactId: "progress",
      parts: [{ content: { case: "text", value: "先读取当前资源。" } }],
    }),
  ];
  if (task.status) task.status.state = TaskState.WORKING;
  await observeTask(request, task);
  await page.goto(`/chat/${task.contextId}`);
  const answer = page.getByTestId("chat-message").filter({ hasText: "先读取当前资源。" });
  await expect(answer).toHaveCount(1);
  const messageId = await answer.getAttribute("data-message-id");
  const guard = await page.getByTestId("chat-viewport").evaluateHandle((viewport) => {
    const state = { missing: false, observer: undefined as MutationObserver | undefined };
    state.observer = new MutationObserver(() => {
      if (!viewport.textContent?.includes("先读取当前资源。")) state.missing = true;
    });
    state.observer.observe(viewport, { childList: true, characterData: true, subtree: true });
    return state;
  });
  for (const kind of ["function_call", "function_response"]) {
    task.artifacts.push(
      create(ArtifactSchema, {
        artifactId: kind,
        parts: [
          {
            metadata: { [partTypeKey]: kind },
            content: {
              case: "data",
              value: fromJson(ValueSchema, {
                id: "read",
                name: "k8s_get_resources",
                args: {},
                response: { output: [] },
              }),
            },
          },
        ],
      }),
    );
    await observeTask(request, task);
    await expect(answer).toBeVisible();
    await expect(answer).toHaveAttribute("data-message-id", messageId ?? "");
    const call = answer.getByTestId("chat-tool-call");
    await expect(call).toHaveCount(1);
    await expect(call).toHaveAttribute(
      "aria-label",
      new RegExp(kind === "function_call" ? "执行中" : "已完成"),
    );
  }
  task.artifacts.push(
    create(ArtifactSchema, {
      artifactId: "final",
      parts: [{ content: { case: "text", value: "所有资源健康。" } }],
    }),
  );
  if (task.status) task.status.state = TaskState.COMPLETED;
  await observeTask(request, task);
  await expect(answer).toContainText("所有资源健康。");
  expect(await guard.evaluate((state) => state.missing)).toBe(false);
  await guard.evaluate((state) => state.observer?.disconnect());
  await page.reload();
  await expect(answer).toContainText("先读取当前资源。");
  await expect(answer).toContainText("所有资源健康。");
  await expect(answer).toHaveAttribute("data-message-id", messageId ?? "");
  await expect(answer.getByTestId("chat-tool-call")).toHaveCount(1);
});

test("shows tool-only turns, keeps parallel calls separate and retains failures and results after reload", async ({
  page,
  request,
}) => {
  const task = await recordedTask(request, ids.chat);
  task.artifacts = [
    create(ArtifactSchema, {
      artifactId: "parallel-calls",
      parts: ["read-a", "read-b"].map((id) =>
        create(PartSchema, {
          metadata: { [partTypeKey]: "function_call" },
          content: {
            case: "data",
            value: fromJson(ValueSchema, {
              id,
              name: "k8s_get_resources",
              args: { namespace: id, token: "private-tool-token" },
            }),
          },
        }),
      ),
    }),
  ];
  if (task.status) task.status.state = TaskState.WORKING;
  await observeTask(request, task);
  await page.goto(`/chat/${task.contextId}`);
  const calls = page.getByTestId("chat-tool-call");
  await expect(calls).toHaveCount(2);
  await expect(calls.first()).toHaveAttribute("aria-label", /执行中/);
  await expect(calls.first().getByTestId("tool-icon")).toHaveAttribute(
    "data-tool-brand",
    "Kubernetes",
  );
  await expect(page.getByTestId("chat-task-panel")).toHaveCount(0);
  await calls.first().click();
  await expect(page.getByRole("dialog").getByTestId("call-input")).toContainText("read-a");
  await expect(page.getByRole("dialog").getByTestId("call-input")).toContainText("[REDACTED]");
  await expect(page.getByRole("dialog")).not.toContainText("private-tool-token");
  const results: { id: string; response: JsonValue }[] = [
    { id: "read-a", response: { output: { healthy: true } } },
    { id: "read-b", response: { error: "upstream unavailable" } },
  ];
  task.artifacts.push(
    create(ArtifactSchema, {
      artifactId: "parallel-results",
      parts: results.map((result) =>
        create(PartSchema, {
          metadata: { [partTypeKey]: "function_response" },
          content: {
            case: "data",
            value: fromJson(ValueSchema, { name: "k8s_get_resources", ...result }),
          },
        }),
      ),
    }),
  );
  if (task.status) task.status.state = TaskState.COMPLETED;
  await observeTask(request, task);
  await expect(calls.first()).toHaveAttribute("aria-label", /已完成/);
  await expect(calls.last()).toHaveAttribute("aria-label", /失败/);
  await expect(page.getByRole("dialog").getByTestId("call-output")).toContainText(
    '"healthy": true',
  );
  await page.screenshot({ path: test.info().outputPath("chat-tool-calls.png") });
  await page.reload();
  await expect(calls).toHaveCount(2);
  await expect(calls.first()).toHaveAttribute("data-call-id", "read-a");
  await expect(calls.last()).toHaveAttribute("data-call-id", "read-b");
  await calls.last().click();
  await expect(page.getByRole("dialog").getByTestId("call-output")).toContainText(
    "upstream unavailable",
  );
  await expect(page.getByTestId("chat-task-panel")).toHaveCount(0);
});

test("shows a native pending approval in the same conversation and retains a rejection reason", async ({
  page,
  request,
}) => {
  await startOperation(page);
  const approval = page.getByTestId("approval-detail");
  await expect(approval.getByTestId("approval-tool")).toHaveText("k8s_apply_manifest");
  await expect(approval.getByRole("button", { name: "拒绝", exact: true })).toBeVisible();
  await decideApproval(page, request, false, "保持现状，先检查依赖");
  await expect(approval.getByRole("button", { name: "拒绝", exact: true })).toHaveCount(0);
  await expect(page.getByTestId("rejection-reason")).toContainText("保持现状，先检查依赖");
  await page.reload();
  await expect(page.getByTestId("rejection-reason")).toContainText("保持现状，先检查依赖");
});

test("keeps the chat entry fixed and never restores another user's last conversation", async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem("agentos-conversation", "/chat/foreign?agent=inspection"),
  );
  await page.goto("/");
  await expect(page).toHaveURL(/\/chat$/);
  await page.goto("/chat?agent=inspection");
  await expect(page.getByTestId("chat-workspace").getByRole("combobox")).toHaveCount(0);
  await page.getByRole("textbox", { name: "消息", exact: true }).fill("你好，入口验收");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page).toHaveURL(/\/chat\/[^/?]+$/);
  await expect(page.getByTestId("chat-message")).toHaveCount(2);
});
