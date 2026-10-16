import { clone, create, toBinary, toJson } from "@bufbuild/protobuf";
import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { encodeEnvelopes } from "@connectrpc/connect/protocol";
import { endStreamFlag } from "@connectrpc/connect/protocol-connect";
import { expect, type Page, test } from "@playwright/test";
import { WatchTaskResponseSchema } from "../../gen/agentos/console/v1/console_service_pb.js";
import { EngineerSchema } from "../../gen/agentos/console/v1/engineer_pb.js";
import { ActivityState } from "../../gen/agentos/console/v1/state_pb.js";
import {
  InteractionKind,
  InteractionSchema,
  type TaskDetail,
  TaskDetailSchema,
} from "../../gen/agentos/console/v1/task_pb.js";
import {
  ChangeSchema,
  ChangeState,
  Governance,
} from "../../gen/agentos/governance/v1/change_pb.js";
import { collaborationDetail, link } from "../fixtures/collaboration.js";
import { resetKagent } from "./kagent.js";

async function observeDetail(page: Page, current: () => TaskDetail) {
  await page.route("**/agentos.console.v1.ConsoleService/WatchTask", async (route) => {
    const response = create(WatchTaskResponseSchema, { task: current() });
    const binary = route.request().headers()["content-type"]?.includes("+proto");
    const data = binary
      ? toBinary(WatchTaskResponseSchema, response)
      : new TextEncoder().encode(JSON.stringify(toJson(WatchTaskResponseSchema, response)));
    await route.fulfill({
      contentType: `application/connect+${binary ? "proto" : "json"}`,
      body: Buffer.from(
        encodeEnvelopes(
          { flags: 0, data },
          { flags: endStreamFlag, data: new TextEncoder().encode("{}") },
        ),
      ),
    });
  });
}

test("shares a work-order node and opens each original approval", async ({ page, request }) => {
  await resetKagent(request);
  const change = create(ChangeSchema, {
    id: "change",
    ticketId: "19",
    ticketUrl: "https://aiops-real-zammad.example/#ticket/zoom/19",
    state: ChangeState.PENDING,
    environment: { name: "aiops-real", governance: Governance.APPROVAL },
  });
  const detail = collaborationDetail(
    [link("first", { target: "asset" }), link("second", { target: "asset" })],
    {
      interactions: ["first", "second"].map((id, index) =>
        create(InteractionSchema, {
          id,
          taskId: `task-${id}`,
          agentId: "asset",
          requestId: `request-${id}`,
          kind: InteractionKind.APPROVAL,
          state: index ? ActivityState.AWAITING_APPROVAL : ActivityState.SUCCEEDED,
          requestedAt: timestampFromMs(index + 1),
          changes: [change],
        }),
      ),
    },
  );
  detail.participants = ["coordinator", "asset"].map((role) =>
    create(EngineerSchema, { id: role, role }),
  );
  await observeDetail(page, () => detail);
  await page.route("**/agentos.console.v1.ConsoleService/ListChanges", (route) =>
    route.fulfill({
      json: { changes: [toJson(ChangeSchema, change), toJson(ChangeSchema, change)] },
    }),
  );
  await page.goto("/tasks/root");
  const ticket = page.locator('[data-ticket="19"][data-environment="aiops-real"]');
  await expect(ticket).toHaveCount(1);
  await expect(ticket).toContainText("工单 #19");
  await expect(ticket.locator('[data-tool-brand="Zammad"]')).toBeVisible();
  await expect(page.locator(".react-flow__node")).toHaveCount(3);
  await expect(page.locator(".react-flow__edge-path")).toHaveCount(2);
  await expect(page.locator(".react-flow__edge-path[marker-start][marker-end]")).toHaveCount(2);
  await ticket.click();
  const drawer = page.getByTestId("agent-drawer");
  const picker = drawer.getByTestId("approval-picker");
  await expect(drawer).toContainText("工单 #19");
  await expect(drawer.getByRole("link", { name: "工单 #19", exact: true })).toHaveCount(1);
  await expect(drawer.getByTestId("change-orders").getByRole("link")).toHaveCount(0);
  await expect(picker).toContainText("第 2 轮");
  await picker.click();
  await expect(page.getByRole("option")).toHaveCount(2);
  await page.getByRole("option").first().click();
  await expect(picker).toContainText("第 1 轮");
  await expect(drawer.getByTestId("approval-detail")).toContainText("已批准");
  await picker.click();
  await page.getByRole("option").last().click();
  await expect(picker).toContainText("第 2 轮");
  await expect(drawer.getByTestId("approval-detail")).toContainText("等待审批");
});

test("merges an already displayed pair of approvals as their shared ticket is discovered", async ({
  page,
  request,
}) => {
  await resetKagent(request);
  const change = create(ChangeSchema, {
    id: "change",
    ticketId: "19",
    ticketUrl: "https://real-zammad.example/#ticket/zoom/19",
    environment: { name: "real", governance: Governance.APPROVAL },
  });
  const identified = collaborationDetail([link("asset")], {
    interactions: ["first", "second"].map((id, index) =>
      create(InteractionSchema, {
        id,
        taskId: "task-asset",
        agentId: "asset",
        kind: InteractionKind.APPROVAL,
        state: ActivityState.SUCCEEDED,
        requestedAt: timestampFromMs(index + 1),
        changes: [change],
      }),
    ),
  });
  identified.participants = ["coordinator", "asset"].map((role) =>
    create(EngineerSchema, { id: role, role }),
  );
  let current = clone(TaskDetailSchema, identified);
  for (const interaction of current.interactions) interaction.changes = [];
  await observeDetail(page, () => current);
  await page.goto("/tasks/root");
  await expect(page.getByTestId("approval-node")).toHaveCount(2);
  current = identified;
  await expect(page.locator('[data-ticket="19"]')).toHaveCount(1);
  await expect(page.getByTestId("approval-node")).toHaveCount(1);
  await expect(page.locator(".react-flow__node")).toHaveCount(3);
  await page.waitForTimeout(1200);
  await expect(
    page.getByTestId("collaboration-graph").getByText("工单 #19", { exact: true }),
  ).toHaveCount(1);
});

test("fits every node of a long workflow on initial load", async ({ page, request }) => {
  await resetKagent(request);
  const detail = collaborationDetail([link("asset")], {
    interactions: Array.from({ length: 13 }, (_, index) =>
      create(InteractionSchema, {
        id: `approval-${index}`,
        taskId: "task-asset",
        agentId: "asset",
        kind: InteractionKind.APPROVAL,
        state: ActivityState.SUCCEEDED,
        changes: [
          create(ChangeSchema, {
            id: `change-${index}`,
            ticketId: String(index + 1),
            environment: { name: "real", governance: Governance.APPROVAL },
          }),
        ],
      }),
    ),
  });
  detail.participants = ["coordinator", "asset"].map((role) =>
    create(EngineerSchema, { id: role, role }),
  );
  await observeDetail(page, () => detail);
  await page.goto("/tasks/root");
  await expect(page.locator(".react-flow__node")).toHaveCount(15);
  await expect
    .poll(() =>
      page.locator(".react-flow").evaluate((canvas) => {
        const frame = canvas.getBoundingClientRect();
        return [...canvas.querySelectorAll(".react-flow__node, .react-flow__edge-path")].every(
          (node) => {
            const box = node.getBoundingClientRect();
            return (
              box.left >= frame.left &&
              box.right <= frame.right &&
              box.top >= frame.top &&
              box.bottom <= frame.bottom
            );
          },
        );
      }),
    )
    .toBe(true);
  expect(
    await page
      .locator(".react-flow__viewport")
      .evaluate((node) => new DOMMatrixReadOnly(getComputedStyle(node).transform).a),
  ).toBeLessThan(0.7);
});
