import { discovery } from "openid-client";
import { ConsoleService } from "../../gen/agentos/console/v1/console_service_pb.js";
import { ManagementService } from "../../gen/agentos/management/v1/management_pb.js";
import { registerDelegation } from "../authorization/delegation.js";
import { authorizationService } from "../authorization/service.js";
import { registerConsole } from "../console/app.js";
import { registerAppAuthorization } from "../mcp-apps/http.js";
import { workspaceContext } from "../platform/access.js";
import { workspaceService } from "../platform/dispatch.js";
import { workspaceTargets } from "../platform/workspace-targets.js";
import { listenConfig, requiredEnv } from "../shared/config.js";
import { registerHealth } from "../shared/health.js";
import { closeOnSignal, platformApp, platformConfig } from "./platform.js";
import { workspaceRuntime } from "./workspace.js";

const config = platformConfig();
const targets = workspaceTargets();
if (targets[0]?.namespace !== config.workspace)
  throw new Error("The first workspace must match KAGENT_NAMESPACE");
if (targets[0].kagentURL !== config.kagent.url)
  throw new Error("The first workspace must match KAGENT_URL");
const app = platformApp();
const origin = requiredEnv("AGENTOS_API_ORIGIN");
const oauth = await discovery(
  new URL(requiredEnv("AGENTOS_OIDC_ISSUER")),
  requiredEnv("AGENTOS_OIDC_CLIENT_ID"),
  requiredEnv("AGENTOS_OIDC_CLIENT_SECRET"),
);
oauth.timeout = 10;
const runtimes = new Map(
  await Promise.all(
    targets.map(
      async (target) =>
        [
          target.namespace,
          await workspaceRuntime(target, {
            kube: config.kube,
            app,
            origin,
            writerRole: requiredEnv("AGENTOS_OIDC_WRITER_ROLE"),
            home: target === targets[0],
          }),
        ] as const,
    ),
  ),
);
const home = runtimes.get(config.workspace);
if (!home) throw new Error("Home workspace unavailable");
await registerDelegation(app, {
  origin,
  returnOrigins: JSON.parse(requiredEnv("AGENTOS_DELEGATION_ORIGINS")),
  client: oauth,
  key: Buffer.from(requiredEnv("AGENTOS_COOKIE_SECRET"), "base64"),
  clients: new Map([...runtimes].map(([namespace, runtime]) => [namespace, runtime.clients])),
});
registerAppAuthorization(app, (namespace) => runtimes.get(namespace));
await registerConsole(app, {
  authorization: authorizationService(
    new Map(
      [...runtimes].map(([namespace, runtime]) => [namespace, runtime.clients.authorization]),
    ),
    config.workspace,
  ),
  context: workspaceContext(home.identity, runtimes),
  service: workspaceService(
    ConsoleService,
    new Map([...runtimes].map(([key, value]) => [key, value.service])),
  ),
  management: workspaceService(
    ManagementService,
    new Map([...runtimes].map(([key, value]) => [key, value.management])),
  ),
});
registerHealth(app, () => [...runtimes.values()].every((runtime) => runtime.access.healthy()));
closeOnSignal(
  app,
  [...runtimes.values()].map((runtime) => runtime.access.close),
);
await home.voice?.listen(listenConfig().host);
await app.listen(listenConfig());
