import { create } from "@bufbuild/protobuf";
import { createClient, createRouterTransport } from "@connectrpc/connect";
import { expect, it } from "vitest";
import {
  ExtMcp,
  McpRequestSchema,
  McpResponseSchema,
} from "../gen/agentgateway/dev/ext_mcp/ext_mcp_pb.js";
import { ExecutionIdentitySchema } from "../gen/agentos/execution/v1/identity_pb.js";
import { SessionSchema } from "../gen/kagent/api/v1/sessions_pb.js";
import { executions } from "../server/authorization/executions.js";
import type { ExecutionRuntime } from "../server/authorization/runtime.js";
import { collaborationGuardrails } from "../server/platform/guardrails.js";
import { memoryStore } from "./fixtures/execution-store.js";
import { environment } from "./harness.js";

it("rejects cross-workspace invocation and native task methods outside the exposed tools", async () => {
  const { clients } = environment();
  const { session } = await clients.sessions.createSession({
    agent: { namespace: "other", name: "engineer" },
    requestId: "scope-test",
  });
  const guard = createClient(
    ExtMcp,
    createRouterTransport((router) =>
      router.service(ExtMcp, collaborationGuardrails(new Map([["agentos", clients]]))),
    ),
  );
  const request = create(McpRequestSchema, {
    method: "tools/call",
    metadataContext: { workspace: "agentos" },
    mcpRequest: new TextEncoder().encode(
      JSON.stringify({ name: "invoke_session", arguments: { session_id: session?.id } }),
    ),
  });
  expect((await guard.checkRequest(request)).result.case).toBe("error");
  request.method = "tasks/cancel";
  expect((await guard.checkRequest(request)).result.case).toBe("error");
  request.method = "tools/list";
  expect((await guard.checkRequest(request)).result.case).toBe("pass");
});

it("filters both structured and readable session results using the verified workspace and candidate scope", async () => {
  const { clients } = environment();
  const guard = createClient(
    ExtMcp,
    createRouterTransport((router) =>
      router.service(ExtMcp, collaborationGuardrails(new Map([["evaluation", clients]]))),
    ),
  );
  const result = {
    content: [{ type: "text", text: "unfiltered foreign sessions" }],
    structuredContent: {
      sessions: [
        { id: "owned", agent: "evaluation/candidate-1-engineer", state: "ready" },
        { id: "other", agent: "evaluation/candidate-2-engineer", state: "ready" },
        { id: "foreign", agent: "production/engineer", state: "ready" },
      ],
      next_page_token: "opaque-native-cursor",
    },
  };
  const response = await guard.checkResponse(
    create(McpResponseSchema, {
      method: "tools/call",
      metadataContext: {
        workspace: "evaluation",
        agentPrefix: "candidate-1-",
        toolName: "list_sessions",
      },
      mcpResponse: new TextEncoder().encode(JSON.stringify(result)),
    }),
  );
  expect(response.result.case).toBe("mutated");
  if (response.result.case !== "mutated") throw new Error("Expected filtered native output");
  const filtered = JSON.parse(new TextDecoder().decode(response.result.value));
  expect(filtered.structuredContent.sessions).toHaveLength(1);
  expect(filtered.structuredContent.next_page_token).toBe("opaque-native-cursor");
  expect(filtered.content[0].text).toContain("owned");
  expect(filtered.content[0].text).not.toMatch(/other|foreign|unfiltered/);
});

it("keeps native discovery inside the signed caller's execution tree", async () => {
  const { clients, fake, sync } = environment([]);
  const registry = executions(memoryStore());
  const alice = create(ExecutionIdentitySchema, {
    subject: "user:alice",
    credential: { case: "service", value: true },
  });
  const bob = create(ExecutionIdentitySchema, { ...alice, subject: "user:bob" });
  const sessions = ["root", "child", "other-root", "foreign", "unbound"].map((id) =>
    create(SessionSchema, { id, agent: { namespace: "agentos", name: "assistant" } }),
  );
  fake.load({ sessions, tasks: [] });
  await registry.bind(sessions[0], alice);
  await registry.bind(sessions[1], alice, sessions[0]);
  await registry.bind(sessions[2], alice);
  await registry.bind(sessions[3], bob);
  const execution = {
    registry,
    actor: async (headers: Record<string, string>) =>
      headers["x-substrate-actor-token"] === "Bearer signed-root" ? sessions[0] : undefined,
  } as unknown as ExecutionRuntime;
  const guard = createClient(
    ExtMcp,
    createRouterTransport((router) =>
      router.service(ExtMcp, collaborationGuardrails(new Map([["agentos", clients]]), execution)),
    ),
  );
  const request = create(McpResponseSchema, {
    method: "tools/call",
    metadataContext: {
      workspace: "agentos",
      toolName: "list_sessions",
      runtimeIdentity: "Bearer signed-root",
    },
    mcpResponse: new TextEncoder().encode(
      JSON.stringify({
        content: [{ type: "text", text: "unfiltered foreign sessions" }],
        structuredContent: {
          sessions: sessions.map((session) => ({
            id: session.id,
            agent: "agentos/assistant",
            state: "ready",
          })),
        },
      }),
    ),
  });
  try {
    const response = await guard.checkResponse(request);
    if (response.result.case !== "mutated") throw new Error("Expected filtered native output");
    const output = JSON.parse(new TextDecoder().decode(response.result.value));
    expect(output.structuredContent.sessions.map((session: { id: string }) => session.id)).toEqual([
      "root",
      "child",
    ]);
    expect(output.content[0].text).not.toMatch(/foreign|unfiltered|other-root|unbound/);
    request.metadataContext = { ...request.metadataContext, runtimeIdentity: "" };
    expect((await guard.checkResponse(request)).result.case).toBe("error");
  } finally {
    sync.close();
  }
});
