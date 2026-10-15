import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import manifest from "../../package.json" with { type: "json" };

/** Keeps invocation, task state and HITL handling in kagent's native MCP. */
export function nativeInvocation(endpoint: URL, token: string, userId: string) {
  return async (sessionId: string, messageId: string, message: string, signal?: AbortSignal) => {
    const client = new Client({ name: "agentos-delegation", version: manifest.version });
    try {
      await client.connect(
        new StreamableHTTPClientTransport(endpoint, {
          requestInit: { headers: { Authorization: `Bearer ${token}`, "X-User-Id": userId } },
        }),
        { signal, timeout: 15_000 },
      );
      return await client.callTool(
        {
          name: "invoke_session",
          arguments: { session_id: sessionId, message_id: messageId, message },
        },
        { signal, timeout: 540_000 },
      );
    } finally {
      await client.close();
    }
  };
}
