import { readFileSync } from "node:fs";
import { rootCertificates } from "node:tls";
import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import {
  ApprovalService,
  type EnvironmentConnection,
} from "../../gen/agentos/governance/v1/governance_pb.js";
import type { EnvironmentTokens } from "../authorization/environment-tokens.js";
import { toolBaseName } from "../read-model/decode/tools.js";

export function approvalEnvironment(connections: EnvironmentConnection[], name: string) {
  const tool = toolBaseName(name);
  return connections
    .toSorted((a, b) => (b.environment?.name.length ?? 0) - (a.environment?.name.length ?? 0))
    .find((item) => item.environment && tool.startsWith(`${item.environment.name}-`));
}

export function approvalClient(connection: EnvironmentConnection, token?: EnvironmentTokens) {
  if (!connection.approvalUrl) throw new Error("An external approval service is required");
  const name = connection.environment?.name;
  const ca =
    process.env.AGENTOS_ENVIRONMENT_CA_DIR && name
      ? [
          ...rootCertificates,
          readFileSync(`${process.env.AGENTOS_ENVIRONMENT_CA_DIR}/${name}/ca.crt`, "utf8"),
        ]
      : undefined;
  return createClient(
    ApprovalService,
    createConnectTransport({
      baseUrl: connection.approvalUrl,
      httpVersion: "1.1",
      nodeOptions: { ca },
      interceptors: [
        (next) => async (request) => {
          if (connection.authorization)
            request.header.set("authorization", connection.authorization);
          else if (token && name)
            request.header.set("authorization", `Bearer ${await token(name, "catalog")}`);
          return next(request);
        },
      ],
    }),
  );
}
