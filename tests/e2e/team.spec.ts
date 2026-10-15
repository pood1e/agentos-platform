import { expect, test } from "@playwright/test";
import { resetKagent } from "./kagent.js";

test("shows pack avatars, falls back to the platform glyph and filters the team", async ({
  page,
  request,
}) => {
  await resetKagent(request);
  await page.goto("/engineers");
  await expect(page.getByTestId("team-card")).toHaveCount(5);
  const pictures = await page
    .getByTestId("team-card")
    .getByTestId("avatar")
    .evaluateAll((elements) =>
      elements.map((element) => ({
        role: element.getAttribute("data-role"),
        image: element.querySelector("image")?.getAttribute("href") ?? "",
        rigged: element.querySelector("mask") !== null,
      })),
    );
  const packed = new Set(["coordinator", "inspection"]);
  for (const picture of pictures)
    expect(picture.image, picture.role ?? "").toBe(
      packed.has(picture.role ?? "") ? `/pack/avatars/${picture.role}.svg` : "",
    );
  expect(pictures.find((picture) => picture.role === "inspection")?.rigged).toBe(false);
  await expect(page.getByRole("img", { name: "巡检", exact: true }).first()).toBeVisible();
  await page.getByRole("textbox", { name: "搜索团队成员", exact: true }).fill("inspection");
  await expect(page.getByTestId("team-card")).toHaveCount(1);
  await expect(page.getByTestId("team-card")).toHaveAttribute("data-role", "inspection");
});
