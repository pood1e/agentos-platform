import { toJson } from "@bufbuild/protobuf";
import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { type APIRequestContext, expect, type Page } from "@playwright/test";
import { type Task, TaskSchema } from "../../gen/a2a_pb.js";
import { ConsoleService } from "../../gen/agentos/console/v1/console_service_pb.js";
import { ActivityState } from "../../gen/agentos/console/v1/state_pb.js";
import { fixtureIds } from "../fixtures/kagent.js";

const control = "http://127.0.0.1:8094";
export const client = createClient(
  ConsoleService,
  createConnectTransport({
    baseUrl: process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:8090",
    httpVersion: "1.1",
  }),
);
export { fixtureIds as ids };

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

/** A browser fixture for the external work-order authority; API boundaries use PostgreSQL tests. */
export async function workOrders(page: Page) {
  await page.route("**/agentos.console.v1.ConsoleService/ListChanges", async (route) => {
    const { taskId } = route.request().postDataJSON() as { taskId: string };
    await route.fulfill({
      json: {
        changes: [
          {
            id: taskId,
            ticketId: "123",
            ticketUrl: `${control}/orders/${taskId}`,
            state: "CHANGE_STATE_PENDING",
            environment: { name: "env-real", governance: "GOVERNANCE_APPROVAL" },
          },
        ],
      },
    });
  });
}

export async function decideWorkOrder(
  page: Page,
  request: APIRequestContext,
  approved: boolean,
  reason = "",
) {
  const link = page.getByTestId("change-orders").first().getByRole("link", { name: "#123" });
  await expect(link).toBeVisible();
  const href = await link.getAttribute("href");
  const id = href?.split("/").at(-1);
  if (!id) throw new Error("work-order reference missing");
  const response = await request.post(
    `${control}/decide?${new URLSearchParams({ id, approved: String(approved), reason })}`,
  );
  expect(response.ok()).toBe(true);
}
