import { create, fromJson, toBinary, toJson } from "@bufbuild/protobuf";
import { timestampFromMs, ValueSchema } from "@bufbuild/protobuf/wkt";
import { encodeEnvelopes } from "@connectrpc/connect/protocol";
import { endStreamFlag } from "@connectrpc/connect/protocol-connect";
import { expect, type Page, test } from "@playwright/test";
import { WatchTaskResponseSchema } from "../../gen/agentos/console/v1/console_service_pb.js";
import { EngineerSchema } from "../../gen/agentos/console/v1/engineer_pb.js";
import {
  AnswerSchema,
  type Interaction,
  InteractionKind,
  InteractionSchema,
} from "../../gen/agentos/console/v1/task_pb.js";
import { ActivityState } from "../../gen/agentos/execution/v1/state_pb.js";
import { collaborationDetail, link } from "../fixtures/collaboration.js";
import { resetKagent } from "./kagent.js";

const answers = [
  { values: ["保留现状"] },
  { values: ["网络", "存储"] },
  { values: ["只检查当前环境"] },
];

async function interactionPage(
  page: Page,
  interaction: Interaction = create(InteractionSchema, {
    id: "human-input",
    taskId: "task-member",
    agentId: "member",
    requestId: "question-1",
    kind: InteractionKind.QUESTION,
    state: ActivityState.AWAITING_INPUT,
    questions: [
      { question: "处理方式", choices: ["保留现状", "执行变更"] },
      { question: "检查范围", choices: ["网络", "存储"], multiple: true },
      { question: "补充说明" },
    ],
  }),
) {
  const detail = collaborationDetail([link("member")], { interactions: [interaction] });
  detail.operate = true;
  detail.participants = ["coordinator", "member"].map((id) =>
    create(EngineerSchema, { id, role: id }),
  );
  await page.route("**/agentos.console.v1.ConsoleService/WatchTask", (route) => {
    const response = create(WatchTaskResponseSchema, { task: detail });
    const binary = route.request().headers()["content-type"]?.includes("+proto");
    const data = binary
      ? toBinary(WatchTaskResponseSchema, response)
      : new TextEncoder().encode(JSON.stringify(toJson(WatchTaskResponseSchema, response)));
    return route.fulfill({
      contentType: `application/connect+${binary ? "proto" : "json"}`,
      body: Buffer.from(
        encodeEnvelopes(
          { flags: 0, data },
          { flags: endStreamFlag, data: new TextEncoder().encode("{}") },
        ),
      ),
    });
  });
  await page.goto("/system-tasks?task=root");
  await page.getByTestId("approval-node").click();
  return { interaction: detail.interactions[0], detail };
}

async function fillAnswer(page: Page) {
  const card = page.getByTestId("approval-detail");
  await card.getByRole("radio", { name: "保留现状", exact: true }).check();
  await card.getByRole("checkbox", { name: "网络", exact: true }).check();
  await card.getByRole("checkbox", { name: "存储", exact: true }).check();
  await card.getByRole("textbox", { name: "补充说明", exact: true }).fill("只检查当前环境");
}

async function readonlyAnswer(page: Page) {
  const card = page.getByTestId("approval-detail");
  await expect(card).toContainText("已回答");
  await expect(card.locator("input, textarea, button")).toHaveCount(0);
  for (const answer of answers)
    for (const value of answer.values) await expect(card).toContainText(value);
  await expect(card).not.toContainText("执行变更");
}

test.beforeEach(async ({ request }) => resetKagent(request));

test("shows readable approval parameters, localizes historical denials and stops waiting for a rejected review", async ({
  page,
}) => {
  let reviews = 0;
  await page.route("**/agentos.console.v1.ConsoleService/ListApprovals", (route) => {
    reviews++;
    return route.fulfill({ json: {} });
  });
  await interactionPage(
    page,
    create(InteractionSchema, {
      id: "denied-approval",
      taskId: "task-member",
      agentId: "member",
      requestId: "review-1",
      kind: InteractionKind.APPROVAL,
      state: ActivityState.REJECTED,
      external: true,
      rejectionReason: "Execution permissions do not allow this operation",
      tools: [
        {
          id: "tool-1",
          name: "publishing_create_ticket",
          args: fromJson(ValueSchema, {
            title: "服务器资产接入",
            body: "补齐资产字段并核验连通性。\n仅处理用户指定的两台设备。",
            targets: ["server-1", "server-2"],
            password: "approval-private-credential",
          }),
        },
      ],
    }),
  );
  const card = page.getByTestId("approval-detail");
  await expect(card.getByTestId("rejection-reason")).toHaveText("执行权限不足，操作已被拒绝。");
  const parameters = card.getByTestId("approval-arguments");
  await expect(parameters.getByRole("table")).toContainText("服务器资产接入");
  await expect(parameters.getByRole("table")).toContainText("仅处理用户指定的两台设备。");
  await expect(parameters.getByRole("table")).toContainText("targets › 1");
  await expect(parameters.getByRole("table")).toContainText("[REDACTED]");
  await expect(card.getByTestId("approval-raw-arguments")).not.toBeVisible();
  await expect(card).not.toContainText("approval-private-credential");
  await expect(card.getByRole("button", { name: "批准并继续", exact: true })).toHaveCount(0);
  await expect(card.getByTestId("external-approvals").locator(".animate-spin")).toHaveCount(0);
  await expect.poll(() => reviews).toBe(1);
  await page.waitForTimeout(2_500);
  expect(reviews).toBe(1);
  await page.screenshot({ path: test.info().outputPath("readable-rejected-approval.png") });
  await card.getByRole("button", { name: "原始参数", exact: true }).click();
  await expect(card.getByTestId("approval-raw-arguments")).toContainText('"title"');
  await expect(card).not.toContainText("approval-private-credential");
  await card.getByRole("button", { name: "原始参数", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(parameters.getByRole("table")).toContainText("服务器资产接入");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: test.info().outputPath("readable-rejected-approval-mobile.png") });
});

test("locks a submitted answer across remounts while the observed task is still pending", async ({
  page,
}) => {
  let release = () => {};
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requests = 0;
  await page.route("**/agentos.console.v1.ConsoleService/RespondInteraction", async (route) => {
    requests++;
    await hold;
    await route.fulfill({ json: {} });
  });
  const { interaction } = await interactionPage(page);
  await fillAnswer(page);
  await page.getByRole("button", { name: "提交回答", exact: true }).click();
  try {
    await expect(page.getByRole("button", { name: "提交回答", exact: true })).toBeDisabled();
    await expect(page.getByRole("radio", { name: "保留现状", exact: true })).toBeDisabled();
    await page.keyboard.press("Escape");
    await page.getByTestId("approval-node").click();
    await expect(page.getByRole("button", { name: "提交回答", exact: true })).toBeDisabled();
    await expect(page.getByRole("radio", { name: "执行变更", exact: true })).toBeDisabled();
    await expect(page.getByRole("radio", { name: "保留现状", exact: true })).toBeChecked();
    await expect(page.getByRole("checkbox", { name: "存储", exact: true })).toBeChecked();
    await expect(page.getByRole("textbox", { name: "补充说明", exact: true })).toHaveValue(
      "只检查当前环境",
    );
  } finally {
    release();
  }
  await readonlyAnswer(page);
  await page.keyboard.press("Escape");
  await page.getByTestId("approval-node").click();
  await readonlyAnswer(page);
  expect(requests).toBe(1);

  interaction.state = ActivityState.SUCCEEDED;
  interaction.answeredAt = timestampFromMs(Date.now());
  interaction.answers = answers.map((answer) => create(AnswerSchema, answer));
  await page.reload();
  await page.getByTestId("approval-node").click();
  await readonlyAnswer(page);
});

test("keeps a failed answer editable and allows a successful retry", async ({ page }) => {
  let requests = 0;
  await page.route("**/agentos.console.v1.ConsoleService/RespondInteraction", (route) => {
    requests++;
    return requests === 1
      ? route.fulfill({ status: 503, json: { code: "unavailable", message: "Unavailable" } })
      : route.fulfill({ json: {} });
  });
  await interactionPage(page);
  await fillAnswer(page);
  const submit = page.getByRole("button", { name: "提交回答", exact: true });
  await submit.click();
  await expect(page.getByTestId("approval-detail").getByRole("alert")).toBeVisible();
  await expect(submit).toBeEnabled();
  await expect(page.getByRole("textbox", { name: "补充说明", exact: true })).toBeEditable();
  await submit.click();
  await readonlyAnswer(page);
  expect(requests).toBe(2);
});

test("scopes submitted answers to their task and request without locking the next question", async ({
  page,
}) => {
  await page.route("**/agentos.console.v1.ConsoleService/RespondInteraction", (route) =>
    route.fulfill({ json: {} }),
  );
  const { interaction, detail } = await interactionPage(page);
  await fillAnswer(page);
  await page.getByRole("button", { name: "提交回答", exact: true }).click();
  await readonlyAnswer(page);
  for (const next of [
    { taskId: "another-task", requestId: "question-1" },
    { taskId: "task-member", requestId: "question-2" },
  ]) {
    await page.keyboard.press("Escape");
    Object.assign(interaction, next);
    interaction.id = `${next.taskId}:human:${next.requestId}`;
    const run = detail.runs.find((run) => run.agentId === "member");
    if (!run) throw new Error("Missing question owner");
    run.taskId = next.taskId;
    detail.delegations[0].targetTaskId = next.taskId;
    await page.locator(`[data-id="interaction:${interaction.id}"]`).click();
    await expect(page.getByRole("radio", { name: "执行变更", exact: true })).toBeEnabled();
    await expect(page.getByRole("textbox", { name: "补充说明", exact: true })).toHaveValue("");
    await expect(page.getByRole("button", { name: "提交回答", exact: true })).toBeDisabled();
  }
});
