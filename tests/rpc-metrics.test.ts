import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import Fastify from "fastify";
import { expect, it, vi } from "vitest";
import { ConsoleService } from "../gen/agentos/console/v1/console_service_pb.js";
import { registerConsole } from "../server/console/app.js";
import { consoleService } from "../server/console/service.js";
import { consoleDependencies, environment, operator } from "./harness.js";
import { allowWorkspace, testWorkspaceContext } from "./workspace-member.js";

const recorded = vi.hoisted(() => [] as { name: string; attributes: Record<string, string> }[]);
vi.mock("@opentelemetry/api", () => ({
  metrics: {
    getMeter: () => ({
      createHistogram: (name: string) => ({
        record: (_seconds: number, attributes: Record<string, string>) =>
          recorded.push({ name, attributes }),
      }),
    }),
  },
}));

it("records inbound RPC duration with its method and status", async () => {
  const env = await environment();
  const app = Fastify();
  await registerConsole(app, {
    context: testWorkspaceContext("agentos", async () => operator, allowWorkspace("agentos")),
    service: consoleService(consoleDependencies(env)),
  });
  const baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
  try {
    await createClient(
      ConsoleService,
      createConnectTransport({ baseUrl, httpVersion: "1.1" }),
    ).getSpeechCapabilities({});
    expect(recorded).toContainEqual({
      name: "rpc.server.call.duration",
      attributes: expect.objectContaining({
        "rpc.method": "agentos.console.v1.ConsoleService/GetSpeechCapabilities",
        "rpc.response.status_code": "ok",
      }),
    });
  } finally {
    await app.close();
    await env.close();
  }
});
