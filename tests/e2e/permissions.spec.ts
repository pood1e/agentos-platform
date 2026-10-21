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
  [Capability.EVALUATIONS_MANAGE, "/engineers/evaluation"],
]);

for (const capability of allCapabilities) {
  test(`limits navigation and direct routes to ${capabilityRole(capability)}`, async ({
    page,
    context,
    request,
  }) => {
    await resetKagent(request);
    const token = await identityToken([capabilityRole(capability)], `manager-${capability}`);
    await context.setExtraHTTPHeaders({ authorization: `Bearer ${token}` });
    if (capability === Capability.EVALUATIONS_MANAGE)
      await page.route("**/agentos.evaluation.v1.EvaluationService/ListCandidates", (route) =>
        route.fulfill({ json: { candidates: [] } }),
      );
    await page.goto(pages.get(capability) ?? "/chat");
    if (pages.has(capability)) await expect(page.getByTestId("advanced")).toBeVisible();
    else await expect(page.getByTestId("advanced")).toHaveCount(0);
    for (const [required, path] of pages) {
      const link = page.locator(`nav a[href="${path}"]`);
      if (required === capability) await expect(link).toBeVisible();
      else await expect(link).toHaveCount(0);
    }
    const forbidden = capability === Capability.AGENTS_MANAGE ? "/engineers/skills" : "/engineers";
    await page.goto(forbidden);
    await expect(page).toHaveURL(/\/chat$/);
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
