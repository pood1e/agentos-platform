import { expect, test } from "@playwright/test";
import { Capability } from "../../gen/agentos/authorization/v1/permission_pb.js";
import { allCapabilities, capabilityRole } from "../../shared/permissions.js";
import { identityToken } from "../fixtures/identity.js";
import { resetKagent } from "./kagent.js";

const pages = new Map([
  [Capability.AGENTS_MANAGE, "/engineers"],
  [Capability.SKILLS_MANAGE, "/engineers/skills"],
  [Capability.MCP_MANAGE, "/engineers/mcp"],
  [Capability.KNOWLEDGE_MANAGE, "/engineers/knowledge"],
  [Capability.MODELS_MANAGE, "/engineers/models"],
  [Capability.HARNESSES_MANAGE, "/engineers/harnesses"],
]);

for (const capability of allCapabilities) {
  test(`limits management actions to ${capabilityRole(capability)} while sharing resource reads`, async ({
    page,
    context,
    request,
  }) => {
    await resetKagent(request);
    const token = await identityToken([capabilityRole(capability)], `manager-${capability}`);
    await context.setExtraHTTPHeaders({ authorization: `Bearer ${token}` });
    await page.goto(pages.get(capability) ?? "/chat");
    await expect(page.getByRole("link", { name: "系统任务", exact: true })).toBeVisible();
    if (pages.has(capability)) await expect(page.getByTestId("advanced")).toBeVisible();
    else await expect(page.getByTestId("advanced")).toHaveCount(0);
    for (const path of pages.values())
      await expect(page.locator(`nav a[href="${path}"]`)).toBeVisible();
    await page.goto("/engineers/skills");
    if (capability === Capability.SKILLS_MANAGE)
      await expect(page.getByRole("button", { name: "新增", exact: true })).toBeVisible();
    else await expect(page.getByRole("button", { name: "新增", exact: true })).toHaveCount(0);
    const denied = await context.request.post(
      "/agentos.management.v1.ManagementService/SaveHarness",
      {
        headers: { "content-type": "application/json", origin: "http://127.0.0.1:8090" },
        data: {},
      },
    );
    expect(denied.status()).toBe(capability === Capability.HARNESSES_MANAGE ? 400 : 403);
    if (capability === Capability.SKILLS_MANAGE) {
      await page.goto("/engineers/skills");
      await page.getByRole("button", { name: "新增", exact: true }).click();
      await page.getByLabel("技能名称", { exact: true }).fill("limited-manager-skill");
      await page
        .getByLabel("镜像地址（含 SHA-256）", { exact: true })
        .fill(`registry.example/skill@sha256:${"b".repeat(64)}`);
      await page.getByRole("button", { name: "保存", exact: true }).click();
      await expect(page.getByTestId("skill-row")).toContainText("limited-manager-skill");
    }
  });
}
