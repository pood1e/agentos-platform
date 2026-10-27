import { describe, expect, it, vi } from "vitest";
import { knowledgeConfig } from "../server/knowledge/config.js";
import { knowledgeService } from "../server/knowledge/service.js";
import { parentTaskKey, resumedTaskKey } from "../server/read-model/decode/messages.js";
import { sessionTools } from "../server/team-sessions/tools.js";
import { decidedTasks } from "./fake-kagent/scenario.js";
import { startContinuations } from "./fixtures/coordination.js";
import { fixtureIds as ids } from "./fixtures/kagent.js";
import { environment, fakeKagent, silent, testBindings, until } from "./harness.js";
import { managementEnvironment } from "./management-harness.js";

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
  it.skipIf(!process.env.CHANGE_TEST_DATABASE_URL)(
    "returns a decided child result to the waiting coordinator exactly once",
    async () => {
      const { fake, projection, reconcile, close } = await environment(decidedTasks());
      const stop = await startContinuations(projection, silent);
      await reconcile.refresh();
      await until(() => fake.received.length === 1);
      const [message] = fake.received;
      expect(message?.messageId).toMatch(new RegExp(`^resume-${ids.approved}-`));
      expect(message?.contextId).toBe((await projection.entry(ids.approvalRoot))?.contextId);
      expect(message?.metadata).toMatchObject({
        [parentTaskKey]: ids.approvalRoot,
        [resumedTaskKey]: ids.approved,
      });
      await reconcile.refresh();
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(fake.received.filter((item) => item.metadata?.[resumedTaskKey])).toHaveLength(1);
      await stop();
      await close();
    },
  );

  it.skipIf(!process.env.CHANGE_TEST_DATABASE_URL)(
    "retries a failed continuation without waiting for another index event",
    async () => {
      const { projection, reconcile, close } = await environment(decidedTasks());
      let stop = async () => {};
      try {
        const send = vi
          .spyOn(projection, "send")
          .mockRejectedValueOnce(new Error("temporarily unavailable"));
        stop = await startContinuations(projection, silent);
        await reconcile.refresh();
        await until(() => send.mock.calls.length === 2, 8_000);
        expect(send.mock.calls[0]?.[1].messageId).toBe(send.mock.calls[1]?.[1].messageId);
      } finally {
        await stop();
        await close();
      }
    },
  );

  it("offers discovery and normalizes drafted approvals", async () => {
    const { clients, fake } = fakeKagent();
    const handler = sessionTools(
      clients,
      "agentos",
      testBindings(fake),
      knowledgeService(
        clients,
        knowledgeConfig({ namespace: "agentos", userId: "agentos", url: "http://localhost" }),
      ),
    );
    const listed = await mcp(handler, "tools/call", {
      name: "list_agents",
      arguments: { namespace: "agentos" },
    });
    const names = listed.structuredContent.agents.map(
      (agent: { ref: { name: string } }) => agent.ref.name,
    );
    expect(names).toContain("coordinator");
    expect(names).not.toContain("assistant");
    const session = (agent: string) =>
      mcp(handler, "tools/call", {
        name: "create_session",
        arguments: {
          agent: { namespace: "agentos", name: agent },
          requestId: agent,
          name: agent,
        },
      });
    expect((await session("inspection")).structuredContent.session.agent.name).toBe("inspection");
    expect(await session("assistant")).toMatchObject({ isError: true });
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

  it("shares curator memory through read-only MCP with a fixed workspace and service identity", async () => {
    const env = await managementEnvironment();
    try {
      const knowledge = knowledgeService(env.clients, env.dependencies.knowledge);
      const handler = sessionTools(env.clients, "agentos", testBindings(env.fake), knowledge);
      const tools = await mcp(handler, "tools/list");
      const search = tools.tools.find((tool: { name: string }) => tool.name === "search_knowledge");
      expect(search.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
      expect(Object.keys(search.inputSchema.properties)).toEqual(["query"]);
      expect(tools.tools.map((tool: { name: string }) => tool.name)).not.toContain("save_memory");
      const scope = env.dependencies.knowledge.scope;
      for (let index = 0; index < 6; index++)
        await env.clients.memory.addSession(
          {
            managementAgent: scope.agentName,
            memory: { content: `Verified finding ${index}`, vector: Array(768).fill(1) },
          },
          { headers: { "x-user-id": scope.userId } },
        );
      await env.clients.memory.addSession(
        {
          managementAgent: scope.agentName,
          memory: { content: "Private user knowledge" },
        },
        { headers: { "x-user-id": "another-user" } },
      );
      await env.clients.memory.addSession(
        {
          managementAgent: "another_team/knowledge",
          memory: { content: "Other team" },
        },
        { headers: { "x-user-id": scope.userId } },
      );
      await knowledge.add("Console entry shared with all engineers");
      expect((await knowledge.list({ query: "", pageSize: 0, pageToken: "" })).totalSize).toBe(7);
      const nativeSearch = vi.spyOn(env.clients.memory, "search");
      const response = await mcp(handler, "tools/call", {
        name: "search_knowledge",
        arguments: { query: "Verified finding" },
      });
      expect(response.isError).not.toBe(true);
      expect(response.structuredContent.memories).toHaveLength(5);
      expect(JSON.stringify(response)).not.toContain("Private user knowledge");
      expect(JSON.stringify(response)).not.toContain("Other team");
      expect(nativeSearch).toHaveBeenCalledWith(
        expect.objectContaining({
          managementAgent: scope.agentName,
          limit: 5,
          minScore: 0.3,
          vector: expect.any(Array),
        }),
        expect.anything(),
      );
      expect(env.fake.memory.records.size).toBe(9);
      for (const args of [
        { query: "Verified", engineer: "another/knowledge" },
        { query: "Verified", userId: "another-user" },
        { query: "Verified", agentName: "another_team__NS__knowledge" },
        { query: " " },
      ])
        expect(
          await mcp(handler, "tools/call", { name: "search_knowledge", arguments: args }),
        ).toMatchObject({ isError: true });
      expect(nativeSearch).toHaveBeenCalledTimes(1);
      expect(
        await mcp(handler, "tools/call", {
          name: "save_memory",
          arguments: { content: "overwrite" },
        }),
      ).toMatchObject({ error: { code: -32602 } });
      expect(env.fake.memory.records.size).toBe(9);
    } finally {
      await env.close();
    }
  });

  it("reports shared knowledge embedding failure without fabricating results", async () => {
    const env = await managementEnvironment();
    try {
      const knowledge = knowledgeService(env.clients, {
        ...env.dependencies.knowledge,
        token: "invalid-token",
      });
      const handler = sessionTools(env.clients, "agentos", testBindings(env.fake), knowledge);
      const nativeSearch = vi.spyOn(env.clients.memory, "search");
      expect(
        await mcp(handler, "tools/call", {
          name: "search_knowledge",
          arguments: { query: "incident" },
        }),
      ).toMatchObject({ isError: true });
      expect(nativeSearch).not.toHaveBeenCalled();
    } finally {
      await env.close();
    }
  });
});
