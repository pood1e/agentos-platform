import { readFileSync } from "node:fs";
import { KubeConfig } from "@kubernetes/client-node";
import Fastify, { type FastifyBaseLogger, type FastifyInstance, LogController } from "fastify";
import { discovery } from "openid-client";
import { environmentCredentials, environmentTokens } from "../authorization/environment-tokens.js";
import { executionAccess } from "../authorization/execution.js";
import { oidcIdentity } from "../authorization/oidc.js";
import type { ExecutionStore } from "../authorization/store.js";
import { toolBindings } from "../governance/bindings.js";
import { governanceConfig } from "../governance/config.js";
import { type KagentClients, kagentClients, kagentTransport } from "../kagent/clients.js";
import { toolMetadata } from "../kagent/tool-metadata.js";
import { taskQueries } from "../read-model/queries.js";
import { kagentConfig, requiredEnv } from "../shared/config.js";

/** Settings every platform process reads from its workload environment. */
export function platformConfig() {
  const kagent = kagentConfig();
  const kube = new KubeConfig();
  kube.loadFromDefault();
  const ca = process.env.AGENTOS_EXECUTION_DATABASE_CA;
  return {
    kagent,
    workspace: kagent.namespace,
    kube,
    database: {
      uri: requiredEnv("AGENTOS_EXECUTION_DATABASE_URL"),
      ca: ca ? readFileSync(ca, "utf8") : undefined,
    },
  };
}

export type PlatformConfig = ReturnType<typeof platformConfig>;

export const platformApp = () =>
  Fastify({
    logger: true,
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 2 * 1024 * 1024,
  });

export const platformClients = (config: PlatformConfig) =>
  kagentClients(kagentTransport(config.kagent));

/** User token verification and the OIDC client that renews offline grants. */
async function userIdentity() {
  const issuer = requiredEnv("AGENTOS_OIDC_ISSUER");
  const oauth = await discovery(
    new URL(issuer),
    requiredEnv("AGENTOS_OIDC_CLIENT_ID"),
    requiredEnv("AGENTOS_OIDC_CLIENT_SECRET"),
  );
  oauth.timeout = 10;
  const identity = await oidcIdentity(
    {
      issuer,
      audience: requiredEnv("AGENTOS_OIDC_AUDIENCE"),
      writerRole: requiredEnv("AGENTOS_OIDC_WRITER_ROLE"),
    },
    oauth,
  );
  return { oauth, identity };
}

/** Compiled tool authorization, environment identity and execution grants of the workspace. */
export async function executionServices(
  config: PlatformConfig,
  clients: KagentClients,
  log: FastifyBaseLogger,
) {
  const access = await toolBindings(config.kube, config.workspace, log);
  const operations = governanceConfig();
  const environmentToken = environmentTokens(
    operations,
    environmentCredentials(config.kube, config.workspace),
    process.env.AGENTOS_USER_TOKEN_EXCHANGE !== "false",
  );
  const metadata = toolMetadata(clients);
  const { oauth, identity } = await userIdentity();
  const execution = await executionAccess({
    database: config.database,
    key: Buffer.from(requiredEnv("AGENTOS_EXECUTION_KEY"), "base64"),
    clients,
    workspace: config.workspace,
    access,
    verify: identity,
    oauth,
    metadata,
  });
  return { access, operations, environmentToken, metadata, oauth, identity, execution };
}

/** Native task queries share the authorization store, without another database client. */
export function queryServices(
  config: PlatformConfig,
  clients: KagentClients,
  executions: ExecutionStore,
) {
  return taskQueries({ workspace: config.workspace, clients, executions });
}

/** Drains the servers on SIGTERM, then closes dependencies in order. */
export function closeOnSignal(app: FastifyInstance, steps: (() => unknown)[]) {
  app.addHook("onClose", async () => {
    for (const step of steps) await step();
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => void app.close());
}
