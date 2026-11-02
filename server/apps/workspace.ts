import type { ServiceImpl } from "@connectrpc/connect";
import { CoreV1Api, CustomObjectsApi, type KubeConfig } from "@kubernetes/client-node";
import type { FastifyInstance } from "fastify";
import type { ConsoleService } from "../../gen/agentos/console/v1/console_service_pb.js";
import type { ManagementService } from "../../gen/agentos/management/v1/management_pb.js";
import { userIdentity } from "../authorization/identity.js";
import { consoleService } from "../console/service.js";
import { toolBindings } from "../governance/bindings.js";
import { kagentClients, kagentTransport } from "../kagent/clients.js";
import { toolMetadata } from "../kagent/tool-metadata.js";
import { knowledgeConfig } from "../knowledge/config.js";
import { resourceStore } from "../management/resources.js";
import { managementService } from "../management/service.js";
import { workflowDocuments } from "../management/workflows/documents.js";
import { mcpApps } from "../mcp-apps/service.js";
import { memberWorkspace } from "../platform/access.js";
import type { WorkspaceTarget } from "../platform/workspace-targets.js";
import { taskQueries } from "../read-model/queries.js";
import { roleDefaults } from "../shared/config.js";
import { voiceFeature } from "../voice/feature.js";
import { speechSettingsStore } from "../voice/settings.js";

export async function workspaceRuntime(
  target: WorkspaceTarget,
  options: {
    kube: KubeConfig;
    app: FastifyInstance;
    origin: string;
    writerRole: string;
    home: boolean;
  },
) {
  const { kube, app, origin, writerRole, home } = options;
  const namespace = target.namespace;
  const release = target.release;
  const clients = kagentClients(kagentTransport({ url: target.kagentURL, namespace }));
  const access = await toolBindings(kube, namespace, app.log);
  const metadata = toolMetadata(clients);
  const projection = taskQueries({ workspace: namespace, clients });
  const speech = speechSettingsStore(
    kube.makeApiClient(CoreV1Api),
    namespace,
    home ? (process.env.AGENTOS_SPEECH_SECRET ?? `${release}-speech`) : `${release}-speech`,
  );
  const voice = home
    ? await voiceFeature(app, {
        kube,
        settings: speech.load,
        projection,
        clients,
        agent: { namespace, name: target.entryAgent },
      })
    : undefined;
  const gatewayURL = home
    ? (process.env.AGENTOS_GATEWAY_URL ??
      `http://${release}-gateway.${namespace}.svc.cluster.local:8080`)
    : `http://${release}-gateway.${namespace}.svc.cluster.local:8080`;
  const gateway = {
    namespace,
    name: `${release}-gateway`,
    url: gatewayURL,
    mcpUrl: home
      ? (process.env.AGENTOS_MCP_GATEWAY_URL ??
        `http://${release}-mcp-gateway.${namespace}.svc.cluster.local:8080`)
      : `http://${release}-mcp-gateway.${namespace}.svc.cluster.local:8080`,
    nativeAuthorityBackend: `${release}-native-authority`,
  };
  const apps = mcpApps({
    clients,
    projection,
    namespace,
    access,
    metadata,
    sandboxOrigin: process.env.AGENTOS_SANDBOX_ORIGIN ?? "",
    gatewayURL,
    log: app.log,
  });
  const service: ServiceImpl<typeof ConsoleService> = consoleService({
    metadata,
    apps,
    projection,
    clients,
    namespace,
    access,
    roleDefaults: roleDefaults(target.harness),
    voice: voice?.console,
    entryAgent: target.entryAgent,
    delegationUrl: `${origin}/delegation/start`,
  });
  const management: ServiceImpl<typeof ManagementService> = managementService({
    access,
    documents: workflowDocuments(
      kube.makeApiClient(CoreV1Api),
      kube.makeApiClient(CustomObjectsApi),
      namespace,
    ),
    clients,
    store: resourceStore(kube, namespace, `${release}-skills`, clients),
    gateway,
    knowledge: knowledgeConfig({ namespace }),
    speech,
  });
  return {
    target,
    entryAgent: target.entryAgent,
    clients,
    access,
    apps,
    identity: userIdentity(clients, writerRole),
    member: memberWorkspace(clients.authorization, namespace),
    service,
    management,
    voice,
  };
}

export type WorkspaceRuntime = Awaited<ReturnType<typeof workspaceRuntime>>;
