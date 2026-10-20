import { toJson } from "@bufbuild/protobuf";
import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { type APIRequestContext, expect, type Page } from "@playwright/test";
import { type Task, TaskSchema } from "../../gen/a2a_pb.js";
import { ConsoleService } from "../../gen/agentos/console/v1/console_service_pb.js";
import { ActivityState } from "../../gen/agentos/execution/v1/state_pb.js";
import { testToken } from "../fixtures/identity.js";
import { fixtureIds } from "../fixtures/kagent.js";

const control = "http://127.0.0.1:8094";
export const client = createClient(
  ConsoleService,
  createConnectTransport({
    baseUrl: process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:8090",
    httpVersion: "1.1",
    interceptors: [
      (next) => (request) => {
        request.header.set("authorization", `Bearer ${testToken}`);
        return next(request);
      },
    ],
  }),
);
export { fixtureIds as ids };

export async function bindSessions(request: APIRequestContext, ids: string[]) {
  const query = new URLSearchParams(ids.map((id) => ["session", id]));
  const response = await request.post(`${control}/bind?${query}`);
  expect(response.ok()).toBe(true);
}

/** Restores the recorded kagent state, including the pending approval. */
export async function resetKagent(request: APIRequestContext) {
  await request.post(`${control}/reset`);
  await expect
    .poll(async () => (await client.listTasks({ query: fixtureIds.approvalRoot })).tasks[0]?.state)
    .toBe(ActivityState.AWAITING_APPROVAL);
}

/** Adds read-only operations so that history spans several pages. */
export async function seedOperations(request: APIRequestContext, count: number) {
  await request.post(`${control}/seed?count=${count}`);
}

export async function taskState(request: APIRequestContext, id: string, state: string) {
  await request.post(`${control}/state?id=${id}&state=${state}`);
}

export async function observeTask(request: APIRequestContext, task: Task) {
  const response = await request.post(`${control}/observe`, { data: toJson(TaskSchema, task) });
  expect(response.ok()).toBe(true);
}

export async function startOperation(
  page: Page,
  text = "创建 ConfigMap approval-smoke 并验证结果",
) {
  await page.goto("/chat");
  await page.getByRole("textbox", { name: "消息", exact: true }).fill(text);
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.getByTestId("approval-detail")).toBeVisible();
  await expect(page.getByTestId("chat-task")).toHaveCount(1);
}

/** Resolves the native pause through the same public API as the approval buttons. */
export async function decideApproval(
  page: Page,
  _request: APIRequestContext,
  approved: boolean,
  reason = "",
) {
  const approval = page.getByTestId("approval-detail").last();
  if (reason) {
    const taskId = new URL(page.url()).pathname.split("/").at(-1) ?? "";
    const list = await client.listTasks({ states: [ActivityState.AWAITING_APPROVAL] });
    const task = list.tasks.find((item) => item.id === taskId) ?? list.tasks[0];
    if (!task) throw new Error("Pending task is missing");
    const controller = new AbortController();
    try {
      for await (const { task: detail } of client.watchTask(
        { taskId: task.id },
        { signal: controller.signal },
      )) {
        const interaction = detail?.interactions.find(
          (item) => item.state === ActivityState.AWAITING_APPROVAL,
        );
        if (!interaction) throw new Error("Pending interaction is missing");
        await client.respondInteraction({
          taskId: interaction.taskId,
          requestId: interaction.requestId,
          decision: {
            case: "approval",
            value: {
              approvals: interaction.tools.map((tool) => ({
                id: tool.id,
                approved,
                rejectionReason: reason,
              })),
            },
          },
        });
        return;
      }
    } finally {
      controller.abort();
    }
  } else {
    await approval
      .getByRole("button", { name: approved ? "批准并继续" : "拒绝", exact: true })
      .click();
  }
}
