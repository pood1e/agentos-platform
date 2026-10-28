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
});
