import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { toNodeHandler } from "@modelcontextprotocol/node";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { sessionTools } from "../server/team-sessions/tools.js";
import { fakeKagent, testBindings } from "./harness.js";

async function mcp(handler: ReturnType<typeof sessionTools>, method: string, params = {}) {
  const response = await handler.fetch(
    new Request("http://127.0.0.1/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
  );
  const body = await response.text();
  const payload = JSON.parse(body.startsWith("event:") ? (body.split("data: ")[1] ?? "") : body);
  return payload.result ?? { error: payload.error };
}

describe("team sessions", () => {
  it("offers discovery and normalizes drafted approvals", async () => {
    const { clients, fake } = fakeKagent();
    const handler = sessionTools(clients, "agentos", testBindings(fake));
    const listed = await mcp(handler, "tools/list");
    expect(listed.tools.map((tool: { name: string }) => tool.name).sort()).toEqual([
      "list_role_tools",
      "prepare_role",
    ]);
    const drafted = await mcp(handler, "tools/call", {
      name: "prepare_role",
      arguments: {
        name: "service-health",
        displayName: "服务健康工程师",
        systemPrompt: "Inspect services.",
        tools: [
          {
            server: "kagent-tool-server",
            tools: ["k8s_get_resources", "k8s_describe_resource"],
            requireApproval: false,
          },
        ],
      },
    });
    expect(drafted.structuredContent.tools).toEqual([
      { server: "kagent-tool-server", tools: ["k8s_get_resources", "k8s_describe_resource"] },
    ]);
    const denied = await mcp(handler, "tools/call", {
      name: "prepare_role",
      arguments: {
        name: "service-health",
        displayName: "服务健康工程师",
        systemPrompt: "Inspect services.",
        tools: [{ server: "remediation-tools", tools: ["k8s_apply_manifest"] }],
      },
    });
    expect(denied.structuredContent.tools).toEqual([
      { server: "remediation-tools", tools: ["k8s_apply_manifest"], requireApproval: true },
    ]);
  });

  it("prepares policy-authorized roles through the HTTP SDK when discovery is empty", async () => {
    const { clients, fake } = fakeKagent();
    for (const server of fake.toolServers) server.discoveredTools = [];
    const handler = toNodeHandler(sessionTools(clients, "agentos", testBindings(fake)));
    const app = Fastify();
    app.route({
      method: ["GET", "POST", "DELETE"],
      url: "/mcp",
      handler: async (request, reply) => {
        reply.hijack();
        await handler(request.raw, reply.raw, request.body);
      },
    });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const client = new Client({ name: "team-sessions-test", version: "1.0.0" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL("/mcp", address)));
      expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("prepare_role");
      const prepared = await client.callTool({
        name: "prepare_role",
        arguments: {
          name: "service-health",
          displayName: "Service health",
          systemPrompt: "Inspect services.",
          tools: [{ server: "kagent-tool-server", tools: ["k8s_get_resources"] }],
        },
      });
      expect(prepared.structuredContent).toMatchObject({
        tools: [{ server: "kagent-tool-server", tools: ["k8s_get_resources"] }],
      });
      const rejected = await client.callTool({
        name: "prepare_role",
        arguments: {
          name: "service-health",
          displayName: "Service health",
          systemPrompt: "Inspect services.",
          tools: [{ server: "kagent-tool-server", tools: ["unknown_tool"] }],
        },
      });
      expect(rejected.isError).toBe(true);
    } finally {
      await client.close();
      await app.close();
    }
  });
});
