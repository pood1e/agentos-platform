import { clone, create } from "@bufbuild/protobuf";
import { expect, test } from "@playwright/test";
import { TaskSchema, TaskState, TaskStatusSchema } from "../../gen/a2a_pb.js";
import { fixtureTasks } from "../fixtures/kagent.js";
import { client, ids, observeTask, resetKagent, seedOperations, taskState } from "./kagent.js";

test("shows execution and approval from left to right with Bezier connections", async ({
  page,
  request,
}) => {
  await resetKagent(request);
  await page.goto(`/tasks/${ids.approvalRoot}`);
  await expect(page.getByTestId("approval-node").first()).toBeVisible();
  const columns = await page
    .locator(".react-flow__node [data-column]")
    .evaluateAll((nodes) => nodes.map((node) => Number(node.getAttribute("data-column"))));
  expect(Math.max(...columns)).toBeGreaterThan(Math.min(...columns));
  const paths = await page
    .locator(".react-flow__edge-path")
    .evaluateAll((edges) => edges.map((edge) => edge.getAttribute("d")));
  expect(paths.length).toBeGreaterThan(0);
  expect(paths.every((path) => path?.includes("C"))).toBe(true);
  expect(
    await page.getByTestId("collaboration-step").first().locator("strong").textContent(),
  ).not.toContain("Agent");
});

test("enlarges and shrinks the centered workflow with the available desktop space", async ({
  page,
  request,
}) => {
  await resetKagent(request);
  await page.goto(`/tasks/${ids.dispatchRoot}`);
  await expect(page.locator(".react-flow__node-agent").first()).toBeVisible();
  const zoom = () =>
    page
      .locator(".react-flow__viewport")
      .evaluate((node) => new DOMMatrixReadOnly(getComputedStyle(node).transform).a);
  const scales: number[] = [];
  for (const size of [
    { width: 1512, height: 982 },
    { width: 1100, height: 700 },
    { width: 1920, height: 1080 },
  ]) {
    await page.setViewportSize(size);
    await expect
      .poll(() =>
        page.locator(".react-flow").evaluate((canvas) => {
          const bounds = canvas.getBoundingClientRect();
          const nodes = [...canvas.querySelectorAll(".react-flow__node")].map((node) =>
            node.getBoundingClientRect(),
          );
          const left = Math.min(...nodes.map((node) => node.left));
          const right = Math.max(...nodes.map((node) => node.right));
          const top = Math.min(...nodes.map((node) => node.top));
          const bottom = Math.max(...nodes.map((node) => node.bottom));
          return {
            fits:
              left >= bounds.left &&
              right <= bounds.right &&
              top >= bounds.top &&
              bottom <= bounds.bottom,
            centerX: Math.round(Math.abs((left + right - bounds.left - bounds.right) / 2)),
            centerY: Math.round(Math.abs((top + bottom - bounds.top - bounds.bottom) / 2)),
          };
        }),
      )
      .toEqual({ fits: true, centerX: 0, centerY: 0 });
    scales.push(await zoom());
  }
  expect(scales[0]).toBeGreaterThan(1);
  expect(scales[1]).toBeLessThan(scales[0] ?? 0);
  expect(scales[2]).toBeGreaterThan(scales[0] ?? 0);
  const enlarged = scales[2] ?? 0;
  await page.locator(".react-flow__controls-zoomout").click();
  await expect.poll(zoom).toBeLessThan(enlarged);
  await page.locator(".react-flow__controls-fitview").click();
  await expect.poll(zoom).toBeCloseTo(enlarged, 5);
});

test("shows single-engineer results without a canvas and keeps tool details accessible", async ({
  page,
  request,
}) => {
  await resetKagent(request);
  await seedOperations(request, 1);
  await expect
    .poll(async () => (await client.listTasks({ query: "synthetic-task-0" })).tasks[0]?.id)
    .toBe("synthetic-task-0");
  await page.goto("/tasks/synthetic-task-0");
  await expect(page.getByTestId("task-engineer")).toBeVisible();
  await expect(page.getByTestId("collaboration-graph")).toHaveCount(0);
  const result = page.getByTestId("task-result");
  await expect(result).toContainText("核验结果：通过");
  expect((await result.boundingBox())?.height).toBeGreaterThan(400);
  await page.getByTestId("task-engineer").click();
  const drawer = page.getByTestId("agent-drawer");
  await expect(drawer.getByTestId("task-prompt")).toContainText("巡检第 0 组工作负载");
  await expect(drawer.getByTestId("drawer-call").first()).toBeVisible();
  await expect(drawer.getByTestId("call-intent").first()).not.toBeEmpty();
  await page.keyboard.press("Escape");
  await taskState(request, "synthetic-task-0", "TASK_STATE_WORKING");
  await expect(page.getByTestId("task-result")).toHaveCount(0);
  await expect(page.getByTestId("task-engineer")).toBeVisible();
  await expect(page.getByTestId("collaboration-graph")).toHaveCount(0);
});

test("reveals the workflow when a running task gains collaboration", async ({ page, request }) => {
  await resetKagent(request);
  const completed = fixtureTasks().find((task) => task.id === ids.dispatchRoot);
  if (!completed) throw new Error("dispatch fixture missing");
  const starting = clone(TaskSchema, completed);
  starting.artifacts = [];
  starting.status = create(TaskStatusSchema, { state: TaskState.WORKING });
  await observeTask(request, starting);
  await page.goto(`/tasks/${ids.dispatchRoot}`);
  await expect(page.getByTestId("task-engineer")).toBeVisible();
  await expect(page.getByTestId("collaboration-graph")).toHaveCount(0);
  await observeTask(request, completed);
  await expect(page.getByTestId("collaboration-graph")).toBeVisible();
  await expect(page.getByTestId("collaboration-step").first()).toBeVisible();
  await expect(page.getByTestId("task-engineer")).toHaveCount(0);
});
