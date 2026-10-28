import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import Fastify from "fastify";
import { expect, it, vi } from "vitest";
import { ConsoleService } from "../gen/agentos/console/v1/console_service_pb.js";
import { ErrorInfoSchema } from "../gen/google/rpc/error_details_pb.js";
import { registerConsole } from "../server/console/app.js";
import { consoleService } from "../server/console/service.js";
import { workspaceContext } from "../server/platform/access.js";
import { registerHealth } from "../server/shared/health.js";
import { environment, operator, testBindings } from "./harness.js";

it("serves typed RPC errors and separates liveness from subscribed readiness", async () => {
  const env = await environment();
  const app = Fastify();
  await registerConsole(app, {
    context: workspaceContext("agentos", "assistant", async () => operator),
    service: consoleService({
      ...env,
      namespace: "agentos",
      access: testBindings(env.fake),
      roleDefaults: { modelConfig: "default-model-config", harness: "standard" },
      replaceTemplate: async (value) => env.fake.replaceTemplate(value),
    }),
  });
  let ready = true;
  registerHealth(app, () => ready);
  const url = await app.listen({ host: "127.0.0.1", port: 0 });
  const client = createClient(
    ConsoleService,
    createConnectTransport({ baseUrl: url, httpVersion: "1.1" }),
  );
  try {
    expect((await app.inject("/healthz")).statusCode).toBe(200);
    expect((await app.inject("/readyz")).statusCode).toBe(200);
    expect((await app.inject("/api/snapshot")).statusCode).toBe(404);
    const error = await client
      .sendMessage({
        agent: { namespace: "agentos", name: "assistant" },
        messageId: "invalid",
        text: "x".repeat(8_001),
      })
      .catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ConnectError);
    if (!(error instanceof ConnectError)) throw new Error("expected a ConnectError");
    expect(error.code).toBe(Code.InvalidArgument);
    expect(error.findDetails(ErrorInfoSchema)[0]?.reason).toBe("chat.invalidMessage");
    const failure = vi.spyOn(app.log, "error");
    vi.spyOn(env.projection, "operations").mockRejectedValueOnce(new Error("internal detail"));
    const hidden = await client.listTasks({}).catch((reason: unknown) => reason);
    if (!(hidden instanceof ConnectError)) throw new Error("expected a ConnectError");
    expect(hidden.rawMessage).toBe("request failed");
    expect(hidden.findDetails(ErrorInfoSchema)).toEqual([]);
    expect(failure).toHaveBeenCalledOnce();
    ready = false;
    expect((await app.inject("/readyz")).statusCode).toBe(503);
    expect((await app.inject("/healthz")).statusCode).toBe(200);
  } finally {
    await app.close();
    await env.close();
  }
});
