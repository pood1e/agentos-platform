import { create } from "@bufbuild/protobuf";
import { expect, test } from "@playwright/test";
import { ArtifactSchema, TaskState } from "../../gen/a2a_pb.js";
import { batches, notes, orderedChat } from "../fixtures/ordered-chat.js";
import { ids, observeTask, recordedTask, resetKagent } from "./kagent.js";

test.beforeEach(async ({ request }) => resetKagent(request));

test("interleaves narration and parallel tool batches during streaming, completion and reload", async ({
  page,
  request,
}) => {
  const task = await recordedTask(request, ids.chat);
  task.artifacts = orderedChat().artifacts;
  if (task.status) task.status.state = TaskState.WORKING;
  await observeTask(request, task);
  await page.goto(`/chat/${task.contextId}`);
  const reply = page.getByTestId("chat-message").filter({ hasText: notes[0] });
  const blocks = reply.locator('[data-testid="chat-text-part"], [data-testid="chat-tool-call"]');
  const order = () =>
    blocks.evaluateAll((elements) =>
      elements.map(
        (element) => element.getAttribute("data-call-id") ?? element.textContent?.trim(),
      ),
    );
  const expected = batches.flatMap((size, batch) => [
    notes[batch],
    ...Array.from({ length: size }, (_, index) => `read-${batch}-${index}`),
  ]);
  await expect.poll(order).toEqual(expected);
  const groups = reply.getByTestId("chat-tool-group");
  await expect(groups).toHaveCount(batches.length);
  for (const group of await groups.all()) {
    const bounds = await group.boundingBox();
    expect(bounds?.height).toBeLessThanOrEqual(40);
  }
  const partIds = () =>
    blocks.evaluateAll((elements) =>
      elements.map(
        (element) => element.getAttribute("data-call-id") ?? element.getAttribute("data-part-id"),
      ),
    );
  const before = await partIds();
  expect(before.every(Boolean)).toBe(true);
  expect(new Set(before).size).toBe(before.length);
  await expect(page.getByTestId("chat-task-panel")).toHaveCount(0);
  const final = create(ArtifactSchema, {
    artifactId: "answer",
    parts: [{ content: { case: "text", value: "发现异常。" } }],
  });
  task.artifacts.push(final);
  await observeTask(request, task);
  await expect.poll(order).toEqual([...expected, "发现异常。"]);
  const draft = await partIds();
  expect(draft.slice(0, -1)).toEqual(before);
  final.parts[0].content = { case: "text", value: "发现异常，告警条件需要修正。" };
  if (task.status) task.status.state = TaskState.COMPLETED;
  await observeTask(request, task);
  await expect.poll(order).toEqual([...expected, "发现异常，告警条件需要修正。"]);
  expect(await partIds()).toEqual(draft);
  await page.screenshot({ path: test.info().outputPath("chat-ordered-calls.png") });
  await page.reload();
  await expect.poll(order).toEqual([...expected, "发现异常，告警条件需要修正。"]);
  expect(await partIds()).toEqual(draft);
  const middle = reply.locator('[data-call-id="read-2-1"]');
  await middle.click();
  await expect(page.getByRole("dialog").getByTestId("call-input")).toContainText("read-2-1");
  await expect(page.getByRole("dialog").getByTestId("call-output")).toContainText(
    '"healthy": true',
  );
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await partIds()).toEqual(draft);
  expect(await reply.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
});
