import { readFileSync } from "node:fs";
import { rootCertificates } from "node:tls";
import {
  type CallToolRequest,
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { Agent, fetch as undiciFetch } from "undici";

import type { EnvironmentConnection } from "../../gen/agentos/governance/v1/governance_pb.js";

// Fetch and dispatcher must share an Undici version; its DOM iterator types differ.
const fetch = undiciFetch as unknown as typeof globalThis.fetch;

export async function withEnvironmentMcpClient<T>(
  connection: EnvironmentConnection,
  url: URL,
  token: string,
  signal: AbortSignal,
  operation: (client: Client, signal: AbortSignal) => Promise<T>,
) {
  const gateway = connection.gateway;
  const ca =
    process.env.AGENTOS_ENVIRONMENT_CA_DIR && connection.environment?.name
      ? [
          ...rootCertificates,
          readFileSync(
            `${process.env.AGENTOS_ENVIRONMENT_CA_DIR}/${connection.environment.name}/ca.crt`,
            "utf8",
          ),
        ]
      : undefined;
  const dispatcher = new Agent({
    connect: {
      ca,
      servername: url.hostname === gateway?.address ? gateway.tlsServerName : url.hostname,
    },
  });
  const client = new Client({ name: "AgentOS MCP Apps", version: "1.0.0" });
  const timeout = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
  try {
    await client.connect(
      new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { Authorization: `Bearer ${token}` }, redirect: "error" },
        fetch: (input, init) =>
          fetch(input, {
            ...init,
            ...{ dispatcher },
            signal: AbortSignal.any([timeout, ...(init?.signal ? [init.signal] : [])]),
          }),
      }),
    );
    return await operation(client, timeout);
  } finally {
    await client.close().catch(() => {});
    await dispatcher.close();
  }
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
  const url = new URL(`https://${gateway.address}:${gateway.port}`);
  url.pathname = `/mcp/${identity}/${service}`;
  return withEnvironmentMcpClient(connection, url, token, signal, (client, timeout) =>
    client.callTool(params, { signal: timeout }),
  );
}
