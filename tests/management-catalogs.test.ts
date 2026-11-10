import { Code, createClient, createRouterTransport } from "@connectrpc/connect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ManagementService } from "../gen/agentos/management/v1/management_pb.js";
import { object } from "../shared/json.js";
import { managementEnvironment } from "./management-harness.js";

let env: Awaited<ReturnType<typeof managementEnvironment>>;
let client: ReturnType<typeof createClient<typeof ManagementService>>;
beforeEach(async () => {
  env = await managementEnvironment();
  client = createClient(
    ManagementService,
    createRouterTransport((router) => router.service(ManagementService, env.service)),
  );
});
afterEach(async () => {
  await env.close();
});

describe("shared skill catalog", () => {
  it("validates native sources, preserves ConfigMap metadata and prevents stale updates", async () => {
    const validate = vi.spyOn(env.store, "validate");
    const skill = {
      name: "triage",
      source: { case: "oci" as const, value: `registry.example/triage@sha256:${"a".repeat(64)}` },
    };
    const { item } = await client.saveSkill({
      create: true,
      item: { skill, description: "Triage procedures" },
    });
    expect(validate).toHaveBeenCalledWith(
      "templates",
      expect.objectContaining({
        metadata: { generateName: "skill-validation-", namespace: "agentos" },
      }),
    );
    await client.saveSkill({
      item: { skill: item?.skill, resourceVersion: item?.resourceVersion, description: "Updated" },
    });
    await expect(client.saveSkill({ item })).rejects.toMatchObject({ code: Code.Aborted });
    const cm = env.fake.resources.get("configmaps", "agentos-skills");
    expect(object(object(cm.metadata).annotations)["agentos.dev/ownership"]).toBe("user");
    const { skills } = await client.listSkills({});
    expect(skills[0]?.description).toBe("Updated");
    await client.deleteSkill({ name: "triage", resourceVersion: skills[0]?.resourceVersion });
    expect((await client.listSkills({})).totalSize).toBe(0);
  });
});
