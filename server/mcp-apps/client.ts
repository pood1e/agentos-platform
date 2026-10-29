import { toJsonString } from "@bufbuild/protobuf";
import {
  type CallToolRequest,
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { type AppReference, AppReferenceSchema } from "../../gen/agentos/mcp/v1/app_pb.js";

/** Calls the read-only native gateway view with the current viewer's credential. */
export async function callAppTool(
  gatewayURL: string,
  server: string,
  reference: AppReference,
  token: string,
  params: CallToolRequest["params"],
  signal: AbortSignal,
) {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(server)) throw new Error("MCP App gateway is unavailable");
  const url = new URL(`/apps/mcp/${server}`, gatewayURL);
  const client = new Client({ name: "AgentOS MCP Apps", version: "1.0.0" });
  const timeout = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
  try {
    await client.connect(
      new StreamableHTTPClientTransport(url, {
        requestInit: {
          headers: {
            Authorization: `Bearer ${token}`,
            "x-agentos-app-reference": Buffer.from(
              toJsonString(AppReferenceSchema, reference),
            ).toString("base64url"),
          },
          redirect: "error",
        },
        fetch: (input, init) =>
          fetch(input, {
            ...init,
            signal: AbortSignal.any([timeout, ...(init?.signal ? [init.signal] : [])]),
          }),
      }),
    );
    return await client.callTool(params, { signal: timeout });
  } finally {
    await client.close().catch(() => {});
  }
}
