import Fastify from "fastify";
import { expect, it } from "vitest";

const discoveryMethods = new Set(["initialize", "notifications/initialized", "ping", "tools/list"]);

import { registerTeamSessions } from "../server/team-sessions/app.js";
import { sessionTools } from "../server/team-sessions/tools.js";
import { fakeKagent, testBindings } from "./harness.js";

async function setup(discovery = false) {
  const { clients, fake } = fakeKagent();
  const app = Fastify();
  await registerTeamSessions(
    app,
    sessionTools(clients, "agentos", testBindings(fake)),
    async (headers, method) => {
      if (headers.authorization !== "Bearer verified-workload") throw new Error("Invalid identity");
      if (discovery && !discoveryMethods.has(method))
        throw new Error("Discovery cannot execute tools");
      return {
        clientId: "verified-caller",
        headers: new Headers(),
        scopes: discovery ? ["prepare_role"] : ["list_role_tools"],
      };
    },
  );
  app.get("/healthz", async () => ({ status: "ok" }));
  const url = await app.listen({ host: "127.0.0.1", port: 0 });
  return { app, fake, url };
}

it("exposes the verified caller's scopes and ignores caller-supplied roles", async () => {
  const env = await setup();
  const request = (method: string, params: object, authorization = "Bearer verified-workload") =>
    fetch(`${env.url}/mcp`, {
      method: "POST",
      headers: {
        authorization,
        "x-agentos-role": "admin",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
  try {
    expect((await request("tools/list", {}, "Bearer invalid")).status).toBe(403);
    const response = await request("tools/list", {});
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("list_role_tools");
    expect(body).not.toContain("prepare_role");
    const sessions = env.fake.sessions.size;
    const denied = await request("tools/call", {
      name: "create_session",
      arguments: {
        agent: { namespace: "agentos", name: "inspection" },
        requestId: "forged",
        name: "forged",
      },
    });
    expect(await denied.text()).toMatch(/disabled|not found|Unknown tool/i);
    expect(env.fake.sessions.size).toBe(sessions);
  } finally {
    await env.app.close();
  }
});

it("requires authentication for all HTTP methods and preserves health probes", async () => {
  const env = await setup();
  try {
    for (const method of ["GET", "POST", "DELETE"] as const) {
      expect((await env.app.inject({ method, url: "/mcp" })).statusCode).toBe(403);
      expect(
        (
          await env.app.inject({
            method,
            url: "/mcp",
            headers: { authorization: "Bearer invalid" },
          })
        ).statusCode,
      ).toBe(403);
    }
    expect((await env.app.inject("/healthz")).statusCode).toBe(200);
  } finally {
    await env.app.close();
  }
});

it("allows discovery and rejects method-header spoofing before native creation", async () => {
  const env = await setup(true);
  const request = (method: string) =>
    fetch(`${env.url}/mcp`, {
      method: "POST",
      headers: {
        authorization: "Bearer verified-workload",
        "mcp-method": "tools/list",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        params: {
          name: "create_session",
          arguments: {
            agent: { namespace: "agentos", name: "inspection" },
            requestId: "forged",
            name: "forged",
          },
        },
      }),
    });
  try {
    const sessions = env.fake.sessions.size;
    const response = await request("tools/list");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("prepare_role");
    expect((await request("tools/call")).status).toBe(403);
    expect(env.fake.sessions.size).toBe(sessions);
  } finally {
    await env.app.close();
  }
});
