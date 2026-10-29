import { create } from "@bufbuild/protobuf";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, fromJsonSchema, McpServer } from "@modelcontextprotocol/server";
import Fastify from "fastify";
import { expect, it, onTestFinished } from "vitest";
import { AppReferenceSchema } from "../gen/agentos/mcp/v1/app_pb.js";
import { callAppTool } from "../server/mcp-apps/client.js";

it("calls the native gateway App view with the current viewer's bearer", async () => {
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
  const gateway = Fastify();
  gateway.route({
    method: ["GET", "POST", "DELETE"],
    url: "/apps/mcp/lab-views-assistant",
    handler: async (request, reply) => {
      received.push({ path: request.url, bearer: request.headers.authorization });
      reply.hijack();
      await handler(request.raw, reply.raw, request.body);
    },
  });
  onTestFinished(() => gateway.close());
  const address = await gateway.listen({ host: "127.0.0.1", port: 0 });
  const result = await callAppTool(
    address,
    "lab-views-assistant",
    create(AppReferenceSchema, { taskId: "task", callId: "call" }),
    "current-viewer-token",
    { name: "graph_data", arguments: { focus: "router-1" } },
    new AbortController().signal,
  );
  expect(result.structuredContent).toEqual({ focus: "router-1" });
  expect(received.length).toBeGreaterThanOrEqual(2);
  expect(
    received.every(
      (request) =>
        request.path === "/apps/mcp/lab-views-assistant" &&
        request.bearer === "Bearer current-viewer-token",
    ),
  ).toBe(true);
});

it("rejects gateway redirects before leaking the viewer's credential", async () => {
  let leaked = false;
  const destination = Fastify();
  destination.all("/*", () => {
    leaked = true;
    return {};
  });
  const target = await destination.listen({ host: "127.0.0.1", port: 0 });
  const gateway = Fastify();
  gateway.all("/*", (_request, reply) => reply.redirect(target, 307));
  const address = await gateway.listen({ host: "127.0.0.1", port: 0 });
  onTestFinished(async () => {
    await gateway.close();
    await destination.close();
  });
  await expect(
    callAppTool(
      address,
      "lab-views-assistant",
      create(AppReferenceSchema, { taskId: "task", callId: "call" }),
      "viewer-token",
      { name: "graph_data" },
      new AbortController().signal,
    ),
  ).rejects.toThrow();
  expect(leaked).toBe(false);
});
