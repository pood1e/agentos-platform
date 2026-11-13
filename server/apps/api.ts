import { ConsoleService } from "../../gen/agentos/console/v1/console_service_pb.js";
import { ManagementService } from "../../gen/agentos/management/v1/management_pb.js";
import { MemoryService } from "../../gen/kagent/runtime/v1/memory_pb.js";
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
const writerRole = requiredEnv("AGENTOS_OIDC_WRITER_ROLE");
const runtimes = new Map(
  await Promise.all(
    targets.map(
      async (target) =>
        [
          target.namespace,
          await workspaceRuntime(target, {
            kube,
            app,
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
  memory: workspaceService(
    MemoryService,
    perWorkspace((runtime) => runtime.memory),
  ),
});
registerHealth(app, () => home.access.healthy());
closeOnSignal(
  app,
  [...runtimes.values()].map((runtime) => runtime.access.close),
);
await home.voice?.listen(listenConfig().host);
await app.listen(listenConfig());
