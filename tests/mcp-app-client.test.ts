import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, fromJsonSchema, McpServer } from "@modelcontextprotocol/server";
import Fastify from "fastify";
import { expect, it, onTestFinished, vi } from "vitest";
import { EnvironmentConnectionSchema } from "../gen/agentos/governance/v1/governance_pb.js";
import { callEnvironmentAppTool } from "../server/mcp-apps/client.js";

it("calls an environment App through verified HTTPS with the current viewer's bearer", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentos-app-tls-"));
  onTestFinished(async () => {
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  });
  const cert = await readFile(new URL("fixtures/identity/apps.crt", import.meta.url));
  const key = await readFile(new URL("fixtures/identity/tls.key", import.meta.url));
  await mkdir(join(directory, "lab"));
  await writeFile(join(directory, "lab", "ca.crt"), cert);
  vi.stubEnv("AGENTOS_ENVIRONMENT_CA_DIR", directory);
  const received: { path: string; bearer: string | undefined }[] = [];
  const handler = toNodeHandler(
    createMcpHandler(() => {
      const server = new McpServer({ name: "environment-views", version: "1.0.0" });
      server.registerTool(
        "graph_data",
        {
          inputSchema: fromJsonSchema<{ focus: string }>({
            type: "object",
            properties: { focus: { type: "string" } },
            required: ["focus"],
          }),
        },
        async (args) => ({
          content: [{ type: "text", text: args.focus }],
          structuredContent: { focus: args.focus },
        }),
      );
      return server;
    }),
  );
  const app = Fastify({ https: { cert, key } });
  app.route({
    method: ["GET", "POST", "DELETE"],
    url: "/mcp/assistant/views",
    handler: async (request, reply) => {
      received.push({ path: request.url, bearer: request.headers.authorization });
      reply.hijack();
      await handler(request.raw, reply.raw, request.body);
    },
  });
  onTestFinished(() => app.close());
  const address = new URL(await app.listen({ host: "127.0.0.1", port: 0 }));
  const result = await callEnvironmentAppTool(
    create(EnvironmentConnectionSchema, {
      environment: { name: "lab" },
      gateway: {
        address: "127.0.0.1",
        port: Number(address.port),
        tlsServerName: "environment.test",
      },
    }),
    "assistant",
    "views",
    "current-viewer-token",
    { name: "graph_data", arguments: { focus: "router-1" } },
    new AbortController().signal,
  );
  expect(result.structuredContent).toEqual({ focus: "router-1" });
  expect(received.length).toBeGreaterThanOrEqual(2);
  expect(
    received.every(
      (request) =>
        request.path === "/mcp/assistant/views" && request.bearer === "Bearer current-viewer-token",
    ),
  ).toBe(true);
});
