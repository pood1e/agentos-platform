import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import {
  ApprovalService,
  type EnvironmentConnection,
} from "../../gen/agentos/governance/v1/governance_pb.js";
import { toolBaseName } from "../read-model/decode/tools.js";

export function approvalEnvironment(connections: EnvironmentConnection[], name: string) {
  const tool = toolBaseName(name);
  return connections
    .toSorted((a, b) => (b.environment?.name.length ?? 0) - (a.environment?.name.length ?? 0))
    .find((item) => item.environment && tool.startsWith(`${item.environment.name}-`));
}

export function approvalClient(connection: EnvironmentConnection) {
  if (!connection.approvalUrl) throw new Error("An external approval service is required");
  return createClient(
    ApprovalService,
    createConnectTransport({
      baseUrl: connection.approvalUrl,
      httpVersion: "1.1",
      interceptors: [
        (next) => async (request) => {
          if (connection.authorization)
            request.header.set("authorization", connection.authorization);
          return next(request);
        },
      ],
    }),
  );
}
