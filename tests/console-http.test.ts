import { fileURLToPath } from "node:url";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import Fastify from "fastify";
import { expect, it, vi } from "vitest";
import { ConsoleService } from "../gen/agentos/console/v1/console_service_pb.js";
import { ConversationKind } from "../gen/agentos/console/v1/conversation_pb.js";
import { ErrorInfoSchema } from "../gen/google/rpc/error_details_pb.js";
import { registerConsole } from "../server/console/app.js";
import { loadPack } from "../server/console/pack.js";
import { consoleService } from "../server/console/service.js";
import { fixtureIds as ids } from "./fixtures/kagent.js";
import { environment, testBindings } from "./harness.js";

it("serves typed RPC errors and separates liveness from synchronized readiness", async () => {
  const env = environment();
  await env.sync.refresh();
  const app = Fastify();
  await registerConsole(app, {
    service: consoleService({
      ...env,
      namespace: "agentos",
      access: testBindings(env.fake),
      operations: { $typeName: "agentos.governance.v1.OperationsConfig", environments: [] },
      roleDefaults: { modelConfig: "default-model-config", harness: "standard" },
      replaceTemplate: async (value) => env.fake.replaceTemplate(value),
      pack: loadPack(),
    }),
    ready: () => env.sync.healthy(),
    packRoot: fileURLToPath(new URL("fixtures/pack/", import.meta.url)),
  });
  const url = await app.listen({ host: "127.0.0.1", port: 0 });
  const client = createClient(
    ConsoleService,
    createConnectTransport({ baseUrl: url, httpVersion: "1.1" }),
  );
  try {
    expect((await app.inject("/healthz")).statusCode).toBe(200);
    expect((await app.inject("/readyz")).statusCode).toBe(200);
    expect((await app.inject("/api/snapshot")).statusCode).toBe(404);
    expect((await app.inject("/pack/avatars/coordinator.svg")).statusCode).toBe(200);
    expect((await app.inject("/pack/../package.json")).statusCode).toBe(404);
    expect((await client.getPack({})).pack?.title).toBe("");
    const error = await client
      .sendMessage({
        kind: ConversationKind.ASSISTANT,
        messageId: "invalid",
        text: "x".repeat(8_001),
      })
      .catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ConnectError);
    if (!(error instanceof ConnectError)) throw new Error("expected a ConnectError");
    expect(error.code).toBe(Code.InvalidArgument);
    expect(error.findDetails(ErrorInfoSchema)[0]?.reason).toBe("chat.invalidMessage");
    const failure = vi.spyOn(app.log, "error");
    vi.spyOn(env.clients.a2a, "getTask").mockRejectedValueOnce(new Error("internal detail"));
    const hidden = await client
      .getTaskRun({ taskId: ids.inspection })
      .catch((reason: unknown) => reason);
    if (!(hidden instanceof ConnectError)) throw new Error("expected a ConnectError");
    expect(hidden.rawMessage).toBe("request failed");
    expect(hidden.findDetails(ErrorInfoSchema)).toEqual([]);
    expect(failure).toHaveBeenCalledOnce();
    vi.spyOn(env.sync, "healthy").mockReturnValue(false);
    expect((await app.inject("/readyz")).statusCode).toBe(503);
    expect((await app.inject("/healthz")).statusCode).toBe(200);
    const unavailable = await client.listTasks({}).catch((reason: unknown) => reason);
    expect(unavailable).toBeInstanceOf(ConnectError);
    if (unavailable instanceof ConnectError) expect(unavailable.code).toBe(Code.Unavailable);
  } finally {
    env.sync.close();
    await app.close();
  }
});
