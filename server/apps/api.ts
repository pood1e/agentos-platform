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
import { closeOnSignal, platformApp, platformKube } from "./platform.js";
import { type WorkspaceRuntime, workspaceRuntime } from "./workspace.js";

const kube = platformKube();
const targets = workspaceTargets();
const homeNamespace = targets[0].namespace;
const app = platformApp();
const origin = requiredEnv("AGENTOS_API_ORIGIN");
const writerRole = requiredEnv("AGENTOS_OIDC_WRITER_ROLE");
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
            kube,
            app,
            origin,
            writerRole,
            home: target.namespace === homeNamespace,
          }),
        ] as const,
    ),
  ),
);
const home = runtimes.get(homeNamespace);
if (!home) throw new Error("Home workspace unavailable");
const perWorkspace = <T>(select: (runtime: WorkspaceRuntime) => T) =>
  new Map([...runtimes].map(([namespace, runtime]) => [namespace, select(runtime)]));

await registerDelegation(app, {
  origin,
  returnOrigins: JSON.parse(requiredEnv("AGENTOS_DELEGATION_ORIGINS")),
  client: oauth,
  key: Buffer.from(requiredEnv("AGENTOS_COOKIE_SECRET"), "base64"),
  clients: perWorkspace((runtime) => runtime.clients),
});
registerAppAuthorization(app, (namespace) => runtimes.get(namespace));
await registerConsole(app, {
  authorization: authorizationService(
    perWorkspace((runtime) => runtime.clients.authorization),
    homeNamespace,
    app.log,
  ),
  context: workspaceContext(home.identity, runtimes),
  service: workspaceService(
    ConsoleService,
    perWorkspace((runtime) => runtime.service),
  ),
  management: workspaceService(
    ManagementService,
    perWorkspace((runtime) => runtime.management),
  ),
});
registerHealth(app, () => home.access.healthy());
closeOnSignal(
  app,
  [...runtimes.values()].map((runtime) => runtime.access.close),
);
await home.voice?.listen(listenConfig().host);
await app.listen(listenConfig());
