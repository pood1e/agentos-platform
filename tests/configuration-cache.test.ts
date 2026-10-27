import { expect, it, vi } from "vitest";
import { configurationClients } from "../server/kagent/configuration.js";
import { object } from "../server/read-model/decode/messages.js";
import { managementEnvironment } from "./management-harness.js";

it("uses native watches for configuration reads and observes edits and deletions", async () => {
  const env = await managementEnvironment();
  const catalog = await configurationClients(env.kubeConfig, "agentos", env.clients, {
    error: vi.fn(),
  });
  const get = vi.spyOn(env.clients.models, "getModelConfig");
  const request = { ref: { namespace: "agentos", name: "default-model-config" } };
  try {
    const first = await catalog.clients.models.getModelConfig(request);
    await catalog.clients.models.getModelConfig(request);
    expect(get).not.toHaveBeenCalled();
    expect(catalog.healthy()).toBe(true);
    const resource = env.fake.resources.get("modelconfigs", request.ref.name);
    env.fake.resources.save(
      "modelconfigs",
      { ...resource, spec: { ...object(resource.spec), model: "updated-model" } },
      false,
    );
    await vi.waitFor(async () =>
      expect(
        object(
          (await catalog.clients.models.getModelConfig(request)).modelConfig?.resource?.value?.spec,
        ).model,
      ).toBe("updated-model"),
    );
    expect(object(first.modelConfig?.resource?.value?.spec).model).not.toBe("updated-model");
    const current = env.fake.resources.get("modelconfigs", request.ref.name);
    env.fake.resources.remove(
      "modelconfigs",
      request.ref.name,
      String(object(current.metadata).resourceVersion),
    );
    await vi.waitFor(async () =>
      expect(catalog.clients.models.getModelConfig(request)).rejects.toMatchObject({ code: 5 }),
    );
    await env.close();
    await vi.waitFor(() => expect(catalog.healthy()).toBe(false));
    await expect(catalog.clients.models.getModelConfig(request)).rejects.toMatchObject({
      code: 14,
    });
  } finally {
    await catalog.close();
    await env.close();
  }
});
