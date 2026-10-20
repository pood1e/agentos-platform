import { expect, test } from "@playwright/test";
import { resetKagent, seedOperations } from "./kagent.js";

test("paginates task history with server cursors and searches the full collection", async ({
  page,
  request,
}) => {
  await resetKagent(request);
  await seedOperations(request, 30);
  await page.goto("/tasks");
  const history = page.getByTestId("task-history");
  await history.getByRole("textbox").fill("巡检第");
  await expect(history.getByTestId("history-entry")).toHaveCount(12);
  await expect(history.getByTestId("history-entry").first()).toContainText("巡检第 29 组");
  const first = await history.getByTestId("history-entry").allTextContents();
  await history.getByRole("button", { name: "下一页", exact: true }).click();
  await expect
    .poll(() => history.getByTestId("history-entry").allTextContents())
    .not.toEqual(first);
  await history.getByRole("button", { name: "上一页", exact: true }).click();
  await expect.poll(() => history.getByTestId("history-entry").allTextContents()).toEqual(first);
  await history.getByRole("textbox").fill("巡检第 2 组");
  await expect(history.getByTestId("history-entry")).toHaveCount(1);
  await page.getByRole("link", { name: "聊天", exact: true }).click();
  await expect(page.getByTestId("chat-history").getByRole("textbox")).toHaveValue("");
});
