import { expect, test } from "@playwright/test";
import { ids, resetKagent, taskState } from "./kagent.js";

test("keeps avatar instances through an observed work state change", async ({ page, request }) => {
  await resetKagent(request);
  await page.goto(`/chat?task=${ids.dispatchRoot}`);
  const avatar = page.locator('.react-flow [data-agent="agentos/coordinator"] .avatar').last();
  await expect(avatar).toBeVisible();
  await avatar.evaluate((node) => node.setAttribute("data-instance", "retained"));
  await taskState(request, ids.dispatchRoot, "TASK_STATE_WORKING");
  await expect(
    page.locator('[data-agent="agentos/coordinator"][data-state="WORKING"]').last(),
  ).toBeVisible();
  await expect(avatar).toHaveAttribute("data-instance", "retained");
  await taskState(request, ids.dispatchRoot, "TASK_STATE_COMPLETED");
  await expect(
    page.locator('[data-agent="agentos/coordinator"][data-state="WORKING"]'),
  ).toHaveCount(0);
  await expect(avatar).toHaveAttribute("data-instance", "retained");
});
