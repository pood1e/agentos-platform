import { Code, createClient, createRouterTransport } from "@connectrpc/connect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ManagementService } from "../gen/agentos/management/v1/management_pb.js";
import { object, text } from "../server/read-model/decode/messages.js";
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
afterEach(async () => env.close());
async function request() {
  const current = await env.store.get("agents", "inspection");
  return {
    engineer: { name: "inspection", namespace: "agentos" },
    harness: { name: "codex", namespace: "agentos" },
    generation: BigInt(String(object(current.metadata).generation)),
    expectedUid: text(object(current.metadata).uid),
    modelConfig: { name: "default-model-config", namespace: "agentos" },
    templateResourceVersion: text(
      object(env.fake.template("inspection").resource?.value?.metadata).resourceVersion,
    ),
  };
}

describe("engineer Harness configuration concurrency", () => {
  it("accepts an edit after the controller changes only readiness", async () => {
    const edit = await request();
    const original = await env.store.get("agents", "inspection");
    env.fake.resources.save(
      "agents",
      { ...original, status: { conditions: [{ type: "Ready", status: "False" }] } },
      false,
    );
    const { agent } = await client.setEngineerRuntime(edit);
    expect(object(agent?.resource?.value?.spec).harnessRef).toEqual({ name: "codex" });
    expect(agent?.resource?.value?.status).toEqual({
      conditions: [{ type: "Ready", status: "False" }],
    });
  });

  for (const change of ["status", "spec"] as const) {
    it(`preserves a native ${change} conflict racing with the atomic write`, async () => {
      const edit = await request();
      const write = env.store.save.bind(env.store);
      let raced = false;
      vi.spyOn(env.store, "save").mockImplementation(async (kind, value, create) => {
        if (kind === "agents" && !raced) {
          raced = true;
          const current = await env.store.get("agents", "inspection");
          env.fake.resources.save(
            "agents",
            {
              ...current,
              ...(change === "status"
                ? { status: { observedGeneration: 1 } }
                : { spec: { ...object(current.spec), harnessRef: { name: "memory" } } }),
            },
            false,
          );
        }
        return write(kind, value, create);
      });
      await expect(client.setEngineerRuntime(edit)).rejects.toMatchObject({ code: Code.Aborted });
      expect(object((await env.store.get("agents", "inspection")).spec).harnessRef).toEqual({
        name: change === "status" ? "standard" : "memory",
      });
    });
  }

  it("rejects an engineer recreated under the same name and generation", async () => {
    const edit = await request();
    const original = await env.store.get("agents", "inspection");
    env.fake.agents.splice(
      env.fake.agents.findIndex((agent) => agent.ref?.name === "inspection"),
      1,
    );
    env.fake.resources.save("agents", { ...original, metadata: { name: "inspection" } }, true);
    await expect(client.setEngineerRuntime(edit)).rejects.toMatchObject({ code: Code.Aborted });
    expect(object((await env.store.get("agents", "inspection")).spec).harnessRef).toEqual({
      name: "standard",
    });
  });
});
