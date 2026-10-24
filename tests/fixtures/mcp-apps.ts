import { create } from "@bufbuild/protobuf";
import { createClient, createRouterTransport } from "@connectrpc/connect";
import { onTestFinished, vi } from "vitest";
import { ConsoleService } from "../../gen/agentos/console/v1/console_service_pb.js";
import { PackSchema } from "../../gen/agentos/console/v1/pack_pb.js";
import { ExecutionIdentitySchema } from "../../gen/agentos/execution/v1/identity_pb.js";
import { GovernanceConfigSchema } from "../../gen/agentos/governance/v1/governance_pb.js";
import { executions } from "../../server/authorization/executions.js";
import { consoleService } from "../../server/console/service.js";
import { toolMetadata } from "../../server/kagent/tool-metadata.js";
import { mcpApps } from "../../server/mcp-apps/service.js";
import { workspaceContext } from "../../server/platform/access.js";
import { appScenario } from "../fake-kagent/apps.js";
import { environment, testBindings } from "../harness.js";
import { memoryStore } from "./execution-store.js";

export async function mcpAppsEnvironment(sandboxOrigin = "https://sandbox.example") {
  const env = environment([]);
  onTestFinished(() => env.sync.close());
  const scenario = appScenario(env.fake);
  const owner = create(ExecutionIdentitySchema, {
    subject: "alice",
    credential: { case: "accessToken", value: "latest-alice-token" },
  });
  let caller = owner;
  const registry = executions(memoryStore(), async () => owner);
  await registry.bind(scenario.session, owner);
  await env.sync.refresh();
  const metadata = toolMetadata(env.clients);
  const access = testBindings(env.fake);
  const operations = create(GovernanceConfigSchema, {
    environments: [
      {
        environment: { name: "lab" },
        issuer: "https://identity.test",
        resource: "https://environment.test",
        gateway: { address: "127.0.0.1", port: 8443, tlsServerName: "environment.test" },
      },
    ],
  });
  const token = vi.fn(async () => "delegated-alice-token");
  const invoke = vi.fn(async () => ({
    content: [{ type: "text" as const, text: "12 devices" }],
    structuredContent: { devices: 12 },
  }));
  const apps = mcpApps({
    ...env,
    access,
    operations,
    metadata,
    executions: registry,
    sandboxOrigin,
    token,
    invoke,
  });
  const service = consoleService({
    ...env,
    namespace: "agentos",
    access,
    operations,
    metadata,
    apps,
    executions: registry,
    roleDefaults: { modelConfig: "default-model-config", harness: "standard" },
    replaceTemplate: async (value) => env.fake.replaceTemplate(value),
    pack: create(PackSchema),
  });
  const client = createClient(
    ConsoleService,
    createRouterTransport((router) => router.service(ConsoleService, service), {
      router: { interceptors: [workspaceContext("agentos", "assistant", async () => caller)] },
    }),
  );
  const request = {
    app: { taskId: scenario.task.id, origin: { case: "callId" as const, value: scenario.callId } },
  };
  return {
    ...env,
    ...scenario,
    client,
    metadata,
    registry,
    apps,
    token,
    invoke,
    owner,
    request,
    caller: (value: typeof owner) => {
      caller = value;
    },
  };
}
