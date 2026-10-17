import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";
import { ConsoleService } from "../../gen/agentos/console/v1/console_service_pb.js";
import { EvaluationService } from "../../gen/agentos/evaluation/v1/evaluation_pb.js";
import { ManagementService } from "../../gen/agentos/management/v1/management_pb.js";

export const transport = createConnectTransport({
  baseUrl: window.location.origin,
  interceptors: [
    (next) => async (request) => {
      try {
        const response = await next(request);
        const candidate = response.header.get("x-agentos-candidate");
        if (candidate)
          window.dispatchEvent(new CustomEvent("agentos:candidate", { detail: candidate }));
        return response;
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
export const evaluationClient = createClient(EvaluationService, transport);
