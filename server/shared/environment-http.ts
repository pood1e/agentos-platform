import { readFileSync } from "node:fs";
import { rootCertificates } from "node:tls";
import { Agent, fetch as undiciFetch } from "undici";
import type { EnvironmentConnection } from "../../gen/agentos/governance/v1/governance_pb.js";

export function environmentUrl(connection: EnvironmentConnection, path: string) {
  const gateway = connection.gateway;
  return new URL(
    path,
    gateway ? `https://${gateway.address}:${gateway.port}` : connection.resource,
  );
}

export async function withEnvironmentHttp<T>(
  connection: EnvironmentConnection,
  url: URL,
  operation: (fetch: typeof globalThis.fetch) => Promise<T>,
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
  // Fetch and dispatcher share an Undici version, including its DOM iterator types.
  const fetch = undiciFetch as unknown as typeof globalThis.fetch;
  try {
    return await operation((input, init) => fetch(input, { ...init, ...{ dispatcher } }));
  } finally {
    await dispatcher.close();
  }
}
