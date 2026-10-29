import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { expect, it, vi } from "vitest";
import { GetAppResourceRequestSchema } from "../gen/agentos/console/v1/console_service_pb.js";
import { mcpAppsEnvironment as setup } from "./fixtures/mcp-apps.js";

function deferred() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, resolve: release };
}

it("coalesces concurrent resource reads while preserving each authorized App reference", async () => {
  const env = await setup();
  const request = create(GetAppResourceRequestSchema, env.request);
  const original = env.clients.tools.readMCPAppResource;
  const gate = deferred();
  const read = vi
    .spyOn(env.clients.tools, "readMCPAppResource")
    .mockImplementation(async (...args) => {
      await gate.promise;
      return original(...args);
    });
  const source = vi.spyOn(env.metadata, "tools");
  const loads = Array.from({ length: 40 }, () =>
    env.apps.getResource(request, env.owner, new AbortController().signal),
  );
  try {
    await vi.waitFor(() => expect(source).toHaveBeenCalledTimes(40));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(read).toHaveBeenCalledOnce();
  } finally {
    gate.resolve();
    await Promise.all(loads);
  }
  const result = await env.apps.getResource(request, env.owner, new AbortController().signal);
  expect(result.result.value.contents).toHaveLength(1);
  expect(read).toHaveBeenCalledOnce();
  env.caller({ ...env.owner, subject: "bob" });
  await expect(
    env.apps.getResource(request, { ...env.owner, subject: "bob" }, new AbortController().signal),
  ).rejects.toMatchObject({ code: Code.NotFound });
});

it("does not cache failed resource reads", async () => {
  const env = await setup();
  const request = create(GetAppResourceRequestSchema, env.request);
  const read = vi
    .spyOn(env.clients.tools, "readMCPAppResource")
    .mockRejectedValueOnce(new ConnectError("Resource temporarily unavailable", Code.Unavailable));
  const load = () => env.apps.getResource(request, env.owner, new AbortController().signal);
  await expect(load()).rejects.toMatchObject({ code: Code.Unavailable });
  await expect(load()).resolves.toHaveProperty("result");
  expect(read).toHaveBeenCalledTimes(2);
});

it("keeps a shared resource load alive when one viewer cancels", async () => {
  const env = await setup();
  const request = create(GetAppResourceRequestSchema, env.request);
  const original = env.clients.tools.readMCPAppResource;
  const gate = deferred();
  const read = vi
    .spyOn(env.clients.tools, "readMCPAppResource")
    .mockImplementation(async (...args) => {
      await gate.promise;
      args[1]?.signal?.throwIfAborted();
      return original(...args);
    });
  const source = vi.spyOn(env.metadata, "tools");
  const controller = new AbortController();
  const canceled = env.apps
    .getResource(request, env.owner, controller.signal)
    .catch((error: unknown) => error);
  const remaining = env.apps.getResource(request, env.owner, new AbortController().signal);
  await vi.waitFor(() => expect(source).toHaveBeenCalledTimes(2));
  await new Promise<void>((resolve) => setImmediate(resolve));
  controller.abort();
  gate.resolve();
  await expect(remaining).resolves.toHaveProperty("result");
  expect(await canceled).toMatchObject({ name: "AbortError" });
  expect(read).toHaveBeenCalledOnce();
});

it("rejects a resource response whose URI differs from the original call metadata", async () => {
  const env = await setup();
  const original = env.clients.tools.readMCPAppResource;
  vi.spyOn(env.clients.tools, "readMCPAppResource").mockImplementation(async (...args) => {
    const result = await original(...args);
    const contents = result.result?.value?.contents;
    if (
      !Array.isArray(contents) ||
      !contents[0] ||
      typeof contents[0] !== "object" ||
      Array.isArray(contents[0])
    )
      throw new Error("App resource fixture missing");
    contents[0].uri = "ui://other-service/private.html";
    return result;
  });
  await expect(env.client.getAppResource(env.request)).rejects.toMatchObject({
    code: Code.NotFound,
  });
});
