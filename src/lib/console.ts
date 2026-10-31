import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";
import { ConsoleService } from "../../gen/agentos/console/v1/console_service_pb.js";
import { ManagementService } from "../../gen/agentos/management/v1/management_pb.js";

import i18n from "../i18n/index.js";

export const transport = createConnectTransport({
  baseUrl: window.location.origin,
  interceptors: [
    (next) => (request) => {
      const locale = i18n.resolvedLanguage ?? i18n.language;
      if (locale) request.header.set("Accept-Language", locale);
      return next(request);
    },
  ],
});
export const consoleClient = createClient(ConsoleService, transport);

export const managementClient = createClient(ManagementService, transport);
