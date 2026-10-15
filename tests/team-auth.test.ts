import Fastify from "fastify";
import { expect, it, vi } from "vitest";
import { knowledgeConfig } from "../server/knowledge/config.js";
import { knowledgeService } from "../server/knowledge/service.js";
import { registerTeamSessions } from "../server/team-sessions/app.js";
import { sessionTools } from "../server/team-sessions/tools.js";
import { environment, testBindings } from "./harness.js";

it("protects all MCP methods with a token while keeping health probes available", async () => {
  const { clients, fake } = environment();
  const app = Fastify();
  await registerTeamSessions(
    app,
    sessionTools(
      clients,
      "agentos",
      testBindings(fake),
      knowledgeService(
        clients,
        knowledgeConfig({ namespace: "agentos", userId: "agentos", url: "http://localhost" }),
      ),
      vi.fn(async () => ({ content: [] })),
    ),
    "test-token",
    () => true,
  );
  const url = await app.listen({ host: "127.0.0.1", port: 0 });
  try {
    for (const method of ["GET", "POST", "DELETE"] as const) {
      expect((await app.inject({ method, url: "/mcp" })).statusCode).toBe(401);
      expect(
        (await app.inject({ method, url: "/mcp", headers: { authorization: "Bearer wrong" } }))
          .statusCode,
      ).toBe(401);
    }
    expect((await app.inject("/healthz")).statusCode).toBe(200);
    expect((await app.inject("/readyz")).statusCode).toBe(200);
    const response = await fetch(`${url}/mcp`, {
      method: "POST",
      headers: {
        Authorization: "Bearer test-token",
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("prepare_role");
  } finally {
    await app.close();
  }
});
