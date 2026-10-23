import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";
import { AutomationService } from "../../gen/agentos/automation/v1/service_pb.js";
import { ConsoleService } from "../../gen/agentos/console/v1/console_service_pb.js";
import { ManagementService } from "../../gen/agentos/management/v1/management_pb.js";

export const transport = createConnectTransport({
  baseUrl: window.location.origin,
});
export const consoleClient = createClient(ConsoleService, transport);
export const speechClient = createClient(
  ConsoleService,
  createConnectTransport({ baseUrl: window.location.origin, useBinaryFormat: true }),
);

export const managementClient = createClient(ManagementService, transport);
export const automationClient = createClient(AutomationService, transport);
