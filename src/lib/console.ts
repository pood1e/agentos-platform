import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";
import { ConsoleService } from "../../gen/agentos/console/v1/console_service_pb.js";
import { ManagementService } from "../../gen/agentos/management/v1/management_pb.js";

export const transport = createConnectTransport({
  baseUrl: window.location.origin,
  interceptors: [
    (next) => async (request) => {
      try {
        return await next(request);
      } catch (error) {
        if (ConnectError.from(error).code === Code.Unauthenticated)
          window.location.assign(
            `/oauth2/start?rd=${encodeURIComponent(window.location.pathname + window.location.search)}`,
          );
        throw error;
      }
    },
  ],
});
export const consoleClient = createClient(ConsoleService, transport);

export const managementClient = createClient(ManagementService, transport);
