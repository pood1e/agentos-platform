import {
  type CallToolRequest,
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import type { EnvironmentConnection } from "../../gen/agentos/governance/v1/governance_pb.js";
import { environmentUrl, withEnvironmentHttp } from "../shared/environment-http.js";

export async function withEnvironmentMcpClient<T>(
  connection: EnvironmentConnection,
  url: URL,
  token: string,
  signal: AbortSignal,
  operation: (client: Client, signal: AbortSignal) => Promise<T>,
) {
  return withEnvironmentHttp(connection, url, async (fetch) => {
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
      return await operation(client, timeout);
    } finally {
      await client.close().catch(() => {});
    }
  });
}

export async function callEnvironmentAppTool(
  connection: EnvironmentConnection,
  identity: string,
  service: string,
  token: string,
  params: CallToolRequest["params"],
  signal: AbortSignal,
) {
  const gateway = connection.gateway;
  if (!gateway || !/^[a-z0-9-]+$/.test(identity) || !/^[a-z0-9-]+$/.test(service))
    throw new Error("MCP App gateway is unavailable");
  const url = environmentUrl(connection, `/mcp/${identity}/${service}`);
  return withEnvironmentMcpClient(connection, url, token, signal, (client, timeout) =>
    client.callTool(params, { signal: timeout }),
  );
}
