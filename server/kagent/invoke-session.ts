import {
  Client,
  type FetchLike,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { Agent, fetch } from "undici";
import manifest from "../../package.json" with { type: "json" };

const connectTimeout = 15_000;
const invokeTimeout = 540_000;

/** Keeps invocation, task state and HITL handling in kagent's native MCP. */
export function nativeInvocation(endpoint: URL, token: string, userId: string) {
  return async (
    sessionId: string,
    messageId: string,
    message: string,
    signal?: AbortSignal,
    traceparent?: string,
  ) => {
    const dispatcher = new Agent({
      headersTimeout: invokeTimeout + connectTimeout,
      bodyTimeout: invokeTimeout + connectTimeout,
    });
    const requestInit = {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-User-Id": userId,
        ...(traceparent && /^00-[a-f0-9]{32}-[a-f0-9]{16}-0[01]$/.test(traceparent)
          ? { traceparent }
          : {}),
      },
      dispatcher,
    };
    const client = new Client({ name: "agentos-delegation", version: manifest.version });
    try {
      await client.connect(
        new StreamableHTTPClientTransport(endpoint, {
          // The SDK and Undici describe the same Fetch API with different DOM iterator types.
          fetch: fetch as unknown as FetchLike,
          requestInit,
        }),
        { signal, timeout: connectTimeout },
      );
      return await client.callTool(
        {
          name: "invoke_session",
          arguments: { session_id: sessionId, message_id: messageId, message },
        },
        { signal, timeout: invokeTimeout },
      );
    } finally {
      await client.close();
      await dispatcher.close();
    }
  };
}
