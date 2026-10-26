import { readFileSync } from "node:fs";
import type { JsonObject } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import type { FastifyBaseLogger } from "fastify";
import { createRemoteJWKSet } from "jose";
import type { Configuration } from "openid-client";
import type { McpRequest } from "../../gen/agentgateway/dev/ext_mcp/ext_mcp_pb.js";
import { Control } from "../../gen/ateapi_pb.js";
import type { Session } from "../../gen/kagent/api/v1/sessions_pb.js";
import { scheduledIdentity } from "../automation/identity.js";
import type { BindingView } from "../governance/bindings.js";
import type { KagentClients } from "../kagent/clients.js";
import { type ToolMetadata, toolMetadata } from "../kagent/tool-metadata.js";
import { text } from "../read-model/decode/messages.js";
import { toolBaseName } from "../read-model/decode/tools.js";
import { actorTokenHeader, actorVerifier, runtimeIdentity } from "./actor.js";
import { agentRoles } from "./agent-role.js";
import type { EnvironmentTokens } from "./environment-tokens.js";
import { executions } from "./executions.js";
import { mcpAuthorization } from "./mcp.js";
import { offlineCredentials } from "./offline.js";
import type { jwtIdentity } from "./oidc.js";
import { executionStore } from "./store.js";
import { authorizeToolSelection } from "./tools.js";

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export async function executionRuntime(
  clients: KagentClients,
  workspace: string,
  access: BindingView,
  verify?: ReturnType<typeof jwtIdentity>,
  nativeCreator?: string,
  environmentToken?: EnvironmentTokens,
  oauth?: Configuration,
  metadata: ToolMetadata = toolMetadata(clients),
  log?: Pick<FastifyBaseLogger, "error">,
) {
  const persistent = await executionStore(
    required("AGENTOS_EXECUTION_DATABASE_URL"),
    Buffer.from(required("AGENTOS_EXECUTION_KEY"), "base64"),
    workspace,
    process.env.AGENTOS_EXECUTION_DATABASE_CA
      ? readFileSync(process.env.AGENTOS_EXECUTION_DATABASE_CA, "utf8")
      : undefined,
  );
  const background = oauth && verify ? offlineCredentials(persistent, oauth, verify) : undefined;
  const registry = executions(
    persistent,
    verify,
    nativeCreator ? scheduledIdentity(clients, workspace, nativeCreator) : undefined,
    background?.resolve,
  );
  const workspaces = new Set<string>(
    JSON.parse(process.env.AGENTOS_EXECUTION_WORKSPACES ?? JSON.stringify([workspace])),
  );
  if (!workspaces.has(workspace)) throw new Error("Execution workspace is missing");
  const issuer = required("AGENTOS_ACTOR_ISSUER");
  const audience = JSON.parse(required("AGENTOS_ACTOR_AUDIENCES")) as string[];
  if (
    !Array.isArray(audience) ||
    !audience.length ||
    !audience.every((entry) => typeof entry === "string")
  )
    throw new Error("Runtime audiences are required");
  const substrate = createClient(
    Control,
    createGrpcTransport({
      baseUrl: required("AGENTOS_SUBSTRATE_URL"),
      nodeOptions: { ca: readFileSync(required("AGENTOS_RUNTIME_CA")) },
      interceptors: [
        (next) => (request) => {
          request.header.set(
            "Authorization",
            `Bearer ${readFileSync(required("AGENTOS_RUNTIME_TOKEN"), "utf8").trim()}`,
          );
          return next(request);
        },
      ],
    }),
  );
  const keys = createRemoteJWKSet(new URL("/openid/v1/jwks", issuer));
  const verifyActor = actorVerifier(keys, issuer, audience);
  const resolve = runtimeIdentity(verifyActor, substrate, clients.sessions, workspaces);
  const resolveRuntime = runtimeIdentity(
    actorVerifier(keys, issuer, "kagent-runtime"),
    substrate,
    clients.sessions,
    workspaces,
  );
  const actor = async (
    headers: Record<string, string | string[] | undefined>,
    audience?: string,
  ) => {
    const bearer = headers[actorTokenHeader];
    if (typeof bearer !== "string" || !/^Bearer [^\s,]+$/.test(bearer))
      throw new ConnectError("Signed runtime identity required", Code.Unauthenticated);
    const resolver = audience
      ? runtimeIdentity(
          actorVerifier(keys, issuer, audience),
          substrate,
          clients.sessions,
          workspaces,
        )
      : resolve;
    return resolver(bearer.slice(7));
  };
  const authenticatedActor = async (headers: Headers) => {
    const bearer = headers.get("authorization");
    if (!bearer || !/^Bearer [^\s,]+$/.test(bearer))
      throw new ConnectError("Signed runtime identity required", Code.Unauthenticated);
    return { session: await resolveRuntime(bearer.slice(7)) };
  };
  const agentRole = agentRoles(clients);
  const route = async (target: { serviceNames: string[]; metadataContext?: JsonObject }) => {
    const environment = text(target.metadataContext?.environment);
    const identity = text(target.metadataContext?.identity);
    const policy = await access();
    if (!environmentToken || !policy.connection(target.serviceNames, environment, identity))
      throw new ConnectError("Environment route identity is invalid", Code.PermissionDenied);
    return { environment, identity, policy, token: environmentToken };
  };
  const authorizeTransport = async (target: McpRequest, proof?: string) => {
    const destination = await route(target);
    if (proof) {
      const session = await actor({ [actorTokenHeader]: proof });
      const context = await registry.resolve(session);
      if ((await agentRole(session)).engineer !== destination.identity)
        throw new ConnectError("Execution identity mismatch", Code.PermissionDenied);
      return destination.token(destination.environment, destination.identity, context.identity);
    }
    if (target.metadataContext?.discovery !== true)
      throw new ConnectError("Runtime identity required", Code.PermissionDenied);
    return destination.token(destination.environment, destination.identity);
  };
  const guardrails = mcpAuthorization(
    resolve,
    async (session, tool, target) => {
      const context = await registry.resolve(session);
      const { engineer, role } = await agentRole(session);
      const destination = await route(target);
      if (
        engineer !== destination.identity ||
        !destination.policy.selectedCall(role.tools, target.serviceNames, tool.name) ||
        !destination.policy.permitsCall(engineer, target.serviceNames, tool.name, context.write) ||
        (await metadata.appOnlyCalls(
          destination.policy.environmentCalls(role.tools, tool.name, target.serviceNames),
          workspace,
        ))
      )
        throw new ConnectError(
          "Tool is outside the user's execution permissions",
          Code.PermissionDenied,
        );
      return {
        metadata: {
          initiator: context.identity.subject,
          sessionId: session.id,
          rootSessionId: context.binding.rootSessionId,
        } as JsonObject,
      };
    },
    async (session, target) => {
      const destination = await route(target);
      if (session) {
        await registry.resolve(session);
        if ((await agentRole(session)).engineer !== destination.identity)
          throw new ConnectError("Discovery identity mismatch", Code.PermissionDenied);
      }
      return {};
    },
    (error, target) => {
      const failure = ConnectError.from(error);
      log?.error(
        {
          code: failure.code,
          reason: failure.rawMessage,
          method: target.method,
          services: target.serviceNames,
        },
        "MCP authorization dependency failed",
      );
    },
  );
  const authorizeTools = async (session: Session, tools: string[]) => {
    const context = await registry.resolve(session);
    const { engineer, role } = await agentRole(session);
    const bindings = await access();
    authorizeToolSelection(bindings, engineer, role, tools, context.write);
    if (
      await metadata.appOnlyCalls(
        tools.flatMap((tool) => bindings.environmentCalls(role.tools, toolBaseName(tool))),
        workspace,
      )
    )
      throw new ConnectError("App-only tools cannot be called by Agents", Code.PermissionDenied);
  };
  return {
    registry,
    issuer,
    actorKeys: async () => {
      await keys.reload();
      return keys.jwks();
    },
    background,
    actor,
    authenticatedActor,
    agentRole,
    resolve,
    guardrails,
    authorizeTransport,
    authorizeTools,
    close: persistent.close,
  };
}

export type ExecutionRuntime = Awaited<ReturnType<typeof executionRuntime>>;
