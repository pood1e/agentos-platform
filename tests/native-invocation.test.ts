import { createMcpHandler, fromJsonSchema, McpServer } from "@modelcontextprotocol/server";
import Fastify from "fastify";
import { expect, it, vi } from "vitest";
import { nativeInvocation } from "../server/kagent/invoke-session.js";
import { registerTeamSessions } from "../server/team-sessions/app.js";

it("uses authenticated MCP and preserves native invocation state and structured output", async () => {
  const received = vi.fn();
  const result = {
    content: [{ type: "text" as const, text: "等待用户审批" }],
    structuredContent: {
      session_id: "session",
      context_id: "session",
      task_id: "task",
      state: "TASK_STATE_INPUT_REQUIRED",
      text: "等待用户审批",
    },
  };
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: "native-kagent-test", version: "1" });
    server.registerTool(
      "invoke_session",
      {
        inputSchema: fromJsonSchema({ type: "object", additionalProperties: true }),
      },
      async (args) => {
        received(args);
        return result;
      },
    );
    return server;
  });
  const app = Fastify();
  const callers: unknown[] = [];
  app.addHook("onRequest", async (request) => {
    callers.push(request.headers["x-user-id"]);
  });
  await registerTeamSessions(app, handler, "gateway-test-token", () => true);
  const endpoint = new URL("/mcp", await app.listen({ host: "127.0.0.1", port: 0 }));
  try {
    expect(
      await nativeInvocation(endpoint, "gateway-test-token", "test-user")(
        "session",
        "message-id",
        "只读验证",
      ),
    ).toEqual(result);
    expect(received).toHaveBeenCalledWith({
      session_id: "session",
      message_id: "message-id",
      message: "只读验证",
    });
    await expect(
      nativeInvocation(endpoint, "wrong-token", "test-user")("session", "message-id", "只读验证"),
    ).rejects.toThrow();
    expect(received).toHaveBeenCalledTimes(1);
    expect(callers).not.toContain(undefined);
    expect(new Set(callers)).toEqual(new Set(["test-user"]));
  } finally {
    await app.close();
  }
});
