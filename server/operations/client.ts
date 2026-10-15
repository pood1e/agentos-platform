import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import {
  ChangeControlService,
  type EnvironmentConnection,
} from "../../gen/agentos/governance/v1/change_pb.js";

export function changeClient(connection: EnvironmentConnection) {
  const { controlUrl, authorization } = connection;
  if (!controlUrl || !authorization)
    throw new Error("The environment has no change-control service");
  return createClient(
    ChangeControlService,
    createConnectTransport({
      baseUrl: controlUrl,
      httpVersion: "1.1",
      defaultTimeoutMs: 30_000,
      interceptors: [
        (next) => (request) => {
          request.header.set("Authorization", authorization);
          return next(request);
        },
      ],
    }),
  );
}
