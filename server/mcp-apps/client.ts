import {
  type CallToolRequest,
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";

/** Calls the read-only native gateway view with the current viewer's credential. */
export async function callEnvironmentAppTool(
  gatewayURL: string,
  environment: string,
  identity: string,
  service: string,
  token: string,
  params: CallToolRequest["params"],
  signal: AbortSignal,
) {
  if (![environment, identity, service].every((name) => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)))
    throw new Error("MCP App gateway is unavailable");
  const url = new URL(`/environments/${environment}/mcp/${identity}/${service}`, gatewayURL);
  const client = new Client({ name: "AgentOS MCP Apps", version: "1.0.0" });
  const timeout = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
  try {
    await client.connect(
      new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { Authorization: `Bearer ${token}` }, redirect: "error" },
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
