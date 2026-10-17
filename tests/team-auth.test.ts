import { create } from "@bufbuild/protobuf";
import Fastify from "fastify";
import { expect, it, vi } from "vitest";
import { MemoryServiceSearchResponseSchema } from "../gen/kagent/api/v1alpha1/memory_pb.js";
import { knowledgeConfig } from "../server/knowledge/config.js";
import { knowledgeService } from "../server/knowledge/service.js";
import { registerTeamSessions } from "../server/team-sessions/app.js";
import { sessionTools } from "../server/team-sessions/tools.js";
import { environment, testBindings } from "./harness.js";

it("exposes only the authenticated role's tools and refuses unauthorized calls", async () => {
  const { clients, fake } = environment();
  const prepare = vi.fn();
  const app = Fastify();
  await registerTeamSessions(
    app,
    sessionTools(
      clients,
      "agentos",
      testBindings(fake),
      {
        search: vi.fn(async () => create(MemoryServiceSearchResponseSchema, { memories: [] })),
      },
      vi.fn(async () => ({ content: [] })),
      prepare,
    ),
    "gateway-backend-token",
    async (role) => {
      if (role !== "reader") throw new Error("Unknown role");
      return { scopes: ["search_knowledge"] };
    },
  );
  const url = await app.listen({ host: "127.0.0.1", port: 0 });
  const request = (method: string, params: object, role?: string) =>
    fetch(`${url}/mcp`, {
      method: "POST",
      headers: {
        authorization: "Bearer gateway-backend-token",
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(role ? { "x-agentos-role": role } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
  try {
    expect((await request("tools/list", {})).status).toBe(403);
    expect((await request("tools/list", {}, "another-workspace")).status).toBe(403);
    const response = await request("tools/list", {}, "reader");
    const body = await response.text();
    expect(body).toContain("search_knowledge");
    expect(body).not.toContain("create_session");
    expect(body).not.toContain("prepare_change");
    const denied = await request("tools/call", { name: "prepare_change", arguments: {} }, "reader");
    expect(await denied.text()).toMatch(/disabled|not found|Unknown tool/i);
    expect(prepare).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});

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
      vi.fn(async () => {
        throw new Error("Unexpected change preparation");
      }),
    ),
    "test-token",
  );
  app.get("/healthz", async () => ({ status: "ok" }));
  app.get("/readyz", async () => ({ status: "ready" }));
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
