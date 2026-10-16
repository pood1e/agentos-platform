import { setTimeout } from "node:timers/promises";
import { createMcpHandler, fromJsonSchema, McpServer } from "@modelcontextprotocol/server";
import Fastify from "fastify";
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { expect, it, vi } from "vitest";
import { nativeInvocation } from "../server/kagent/invoke-session.js";
import { registerTeamSessions } from "../server/team-sessions/app.js";

async function nativeMcp(delay = 0) {
  const app = Fastify();
  const received = vi.fn();
  const callers: unknown[] = [];
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
  app.addHook("onRequest", async (request) => {
    callers.push(request.headers["x-user-id"]);
  });
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: "native-collaboration", version: "1.0.0" });
    server.registerTool(
      "invoke_session",
      {
        inputSchema: fromJsonSchema({
          type: "object",
          properties: {
            session_id: { type: "string" },
            message_id: { type: "string" },
            message: { type: "string" },
          },
          required: ["session_id", "message_id", "message"],
        }),
      },
      async (args) => {
        received(args);
        if (delay) await setTimeout(delay);
        return result;
      },
    );
    return server;
  });
  await registerTeamSessions(app, handler, "native-token");
  const url = await app.listen({ host: "127.0.0.1", port: 0 });
  return { app, received, callers, result, url: new URL("/mcp", url) };
}

it("uses authenticated MCP and preserves native invocation state and structured output", async () => {
  const server = await nativeMcp();
  try {
    expect(
      await nativeInvocation(server.url, "native-token", "test-user")(
        "session",
        "message-id",
        "只读验证",
      ),
    ).toEqual(server.result);
    expect(server.received).toHaveBeenCalledWith({
      session_id: "session",
      message_id: "message-id",
      message: "只读验证",
    });
    await expect(
      nativeInvocation(server.url, "wrong-token", "test-user")("session", "message-id", "只读验证"),
    ).rejects.toThrow();
    expect(server.received).toHaveBeenCalledTimes(1);
    expect(server.callers).not.toContain(undefined);
    expect(new Set(server.callers)).toEqual(new Set(["test-user"]));
  } finally {
    await server.app.close();
  }
});

it("keeps delayed native tool results beyond the process HTTP deadline and preserves HITL", async () => {
  const server = await nativeMcp(1_300);
  const previous = getGlobalDispatcher();
  const restrictive = new Agent().compose(
    (dispatch) => (options, handler) =>
      dispatch({ ...options, headersTimeout: 100, bodyTimeout: 100 }, handler),
  );
  setGlobalDispatcher(restrictive);
  try {
    const result = await nativeInvocation(server.url, "native-token", "agentos")(
      "session",
      "message-id",
      "Read-only check",
    );
    expect(result).toEqual(server.result);
    expect(server.received).toHaveBeenCalledExactlyOnceWith({
      session_id: "session",
      message_id: "message-id",
      message: "Read-only check",
    });
  } finally {
    setGlobalDispatcher(previous);
    await restrictive.close();
    await server.app.close();
  }
});

it("still cancels a delayed invocation when its caller aborts", async () => {
  const server = await nativeMcp(1_300);
  const controller = new AbortController();
  try {
    const pending = nativeInvocation(server.url, "native-token", "agentos")(
      "session",
      "cancel-me",
      "Read-only check",
      controller.signal,
    );
    const outcome = pending.then(
      () => undefined,
      (reason: unknown) => reason,
    );
    await vi.waitFor(() => expect(server.received).toHaveBeenCalledOnce());
    controller.abort();
    expect(await outcome).toBeInstanceOf(Error);
  } finally {
    controller.abort();
    await server.app.close();
  }
});
