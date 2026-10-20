import { create } from "@bufbuild/protobuf";
import { createClient, createRouterTransport } from "@connectrpc/connect";
import { expect, it } from "vitest";
import {
  ExtMcp,
  McpRequestSchema,
  McpResponseSchema,
} from "../gen/agentgateway/dev/ext_mcp/ext_mcp_pb.js";
import { collaborationGuardrails } from "../server/platform/guardrails.js";
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
