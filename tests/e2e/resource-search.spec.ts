import { expect, test } from "@playwright/test";
import { resetKagent } from "./kagent.js";

test.beforeEach(async ({ request }) => resetKagent(request));

test("keeps resource rows visible while searching and distinguishes unmatched results", async ({
  page,
}) => {
  let release!: () => void;
  const response = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requested!: () => void;
  const request = new Promise<void>((resolve) => {
    requested = resolve;
  });
  await page.route("**/agentos.management.v1.ManagementService/ListConnections", async (route) => {
    if (!route.request().postDataJSON().query) return route.continue();
    requested();
    await response;
    await route.fulfill({ json: { connections: [], totalSize: 0 } });
  });
  await page.goto("/engineers/models");
  const rows = page.getByTestId("connection-row");
  await expect(rows).toHaveCount(2);
  await expect(page.getByRole("button", { name: "下一页", exact: true })).toHaveCount(0);
  const search = page.getByRole("textbox", { name: "搜索…", exact: true });
  await search.fill("unmatched-model");
  await request;
  await expect(rows).toHaveCount(2);
  await expect(page.getByRole("button", { name: "重新获取", exact: true })).toBeDisabled();
  release();
  await expect(rows).toHaveCount(0);
  await expect(page.getByText("没有匹配的记录", { exact: true })).toBeVisible();
  await search.clear();
  await expect(rows).toHaveCount(2);
});
