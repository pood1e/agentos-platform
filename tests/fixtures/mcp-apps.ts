import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient, createRouterTransport } from "@connectrpc/connect";
import { onTestFinished, vi } from "vitest";
import { UserIdentitySchema } from "../../gen/agentos/authorization/v1/identity_pb.js";
import { ConsoleService } from "../../gen/agentos/console/v1/console_service_pb.js";
import { consoleService } from "../../server/console/service.js";
import { toolMetadata } from "../../server/kagent/tool-metadata.js";
import { mcpApps } from "../../server/mcp-apps/service.js";
import { workspaceContext } from "../../server/platform/access.js";
import { appScenario } from "../fake-kagent/apps.js";
import { environment, testBindings } from "../harness.js";

export async function mcpAppsEnvironment(sandboxOrigin = "https://sandbox.example") {
  const env = await environment([]);
  onTestFinished(() => env.close());
  const scenario = appScenario(env.fake);
  const owner = create(UserIdentitySchema, {
    subject: "user:operator",
  });
  let caller = owner;
  let token = "latest-alice-token";
  const getSession = env.clients.sessions.getSession;
  vi.spyOn(env.clients.sessions, "getSession").mockImplementation(async (request, options) => {
    const result = await getSession(request, options);
    if (result.session?.authority?.initiatorId !== caller.subject)
      throw new ConnectError("native ownership denied", Code.NotFound);
    return result;
  });
  const metadata = toolMetadata(env.clients);
  const access = testBindings(env.fake);
  const invoke = vi.fn(async () => ({
    content: [{ type: "text" as const, text: "12 devices" }],
    structuredContent: { devices: 12 },
  }));
  const apps = mcpApps({
    ...env,
    namespace: "agentos",
    access,
    metadata,
    sandboxOrigin,
    gatewayURL: "http://gateway.test:8080",
    invoke,
  });
  const service = consoleService({
    ...env,
    namespace: "agentos",
    access,
    metadata,
    apps,
    roleDefaults: { modelConfig: "default-model-config", harness: "standard" },
  });
  const client = createClient(
    ConsoleService,
    createRouterTransport((router) => router.service(ConsoleService, service), {
      transport: {
        interceptors: [
          (next) => (request) => {
            if (token) request.header.set("authorization", `Bearer ${token}`);
            return next(request);
          },
        ],
      },
      router: { interceptors: [workspaceContext("agentos", "assistant", async () => caller)] },
    }),
  );
  const request = {
    app: { taskId: scenario.task.id, callId: scenario.callId },
  };
  return {
    ...env,
    ...scenario,
    client,
    metadata,
    apps,
    invoke,
    owner,
    request,
    bearer: (value: string) => {
      token = value;
    },
    caller: (value: typeof owner) => {
      caller = value;
    },
  };
}
