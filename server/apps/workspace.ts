import { CoreV1Api, CustomObjectsApi, type KubeConfig } from "@kubernetes/client-node";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { LRUCache } from "lru-cache";
import { userIdentity } from "../authorization/identity.js";
import { memberWorkspace } from "../authorization/workspaces.js";
import { consoleService } from "../console/service.js";
import { toolBindings } from "../governance/access-plans.js";
import { kagentClients, kagentTransport } from "../kagent/clients.js";
import { toolMetadata } from "../kagent/tool-metadata.js";
import { resourceStore } from "../management/resources.js";
import { managementService } from "../management/service.js";
import { workflowDocuments } from "../management/workflows/documents.js";
import { mcpApps } from "../mcp-apps/service.js";
import type { WorkspaceTarget } from "../platform/workspace-targets.js";
import { taskQueries } from "../read-model/queries.js";
import { unavailable } from "../shared/errors.js";
import { voiceFeature } from "../voice/feature.js";
import { speechSettingsStore } from "../voice/settings.js";

/** A Namespace UID changes only when the Namespace is recreated; session reads need it per call. */
function namespaceUID(core: CoreV1Api, namespace: string, log: FastifyBaseLogger) {
  const cache = new LRUCache<string, string>({
    max: 1,
    ttl: 30_000,
    fetchMethod: async (name) => (await core.readNamespace({ name })).metadata?.uid ?? "",
  });
  return async () => {
    try {
      const uid = await cache.fetch(namespace);
      if (uid) return uid;
    } catch (error) {
      log.warn({ err: error, namespace }, "Workspace Namespace UID unavailable");
    }
    throw unavailable();
  };
}

export async function workspaceRuntime(
  target: WorkspaceTarget,
  options: {
    kube: KubeConfig;
    app: FastifyInstance;
    writerRole: string;
    /** The first configured workspace also hosts the optional voice feature. */
    home: boolean;
  },
) {
  const { kube, app, writerRole, home } = options;
  const { namespace, release, entryAgent, harness } = target;
  const clients = kagentClients(kagentTransport(target.kagentURL));
  const access = await toolBindings(kube, namespace, app.log);
  const metadata = toolMetadata(clients);
  const core = kube.makeApiClient(CoreV1Api);
  const projection = taskQueries({
    workspace: namespace,
    clients,
    workspaceUID: namespaceUID(core, namespace, app.log),
  });
  const speech = speechSettingsStore(core, namespace, `${release}-speech`);
  const voice = home
    ? await voiceFeature(app, {
        kube,
        settings: speech.load,
        projection,
        clients,
        agent: { namespace, name: entryAgent },
      })
    : undefined;
  const apps = mcpApps({
    clients,
    projection,
    namespace,
    access,
    metadata,
    sandboxOrigin: process.env.AGENTOS_SANDBOX_ORIGIN ?? "",
    gatewayURL: `http://${release}-gateway.${namespace}.svc.cluster.local:8080`,
    log: app.log,
  });
  return {
    entryAgent,
    clients,
    access,
    apps,
    identity: userIdentity(clients, writerRole),
    member: memberWorkspace(clients.authorization, namespace),
    service: consoleService({
      metadata,
      apps,
      projection,
      clients,
      namespace,
      access,
      defaultHarness: harness,
      voice: voice?.console,
      entryAgent,
    }),
    management: managementService({
      access,
      documents: workflowDocuments(core, kube.makeApiClient(CustomObjectsApi), namespace),
      clients,
      store: resourceStore(kube, namespace, `${release}-skills`, clients),
      namespace,
      gatewayName: `${release}-gateway`,
      speech,
    }),
    voice,
  };
}

export type WorkspaceRuntime = Awaited<ReturnType<typeof workspaceRuntime>>;
