import { readFileSync } from "node:fs";
import type { JsonObject } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import type { FastifyBaseLogger } from "fastify";
import { createRemoteJWKSet } from "jose";
import type { McpRequest } from "../../gen/agentgateway/dev/ext_mcp/ext_mcp_pb.js";
import { Control } from "../../gen/ateapi_pb.js";
import type { BindingView } from "../governance/bindings.js";
import type { KagentClients } from "../kagent/clients.js";
import type { ToolMetadata } from "../kagent/tool-metadata.js";
import { text } from "../read-model/decode/messages.js";
import { requiredEnv } from "../shared/config.js";
import { actorTokenHeader, actorVerifier, runtimeIdentity } from "./actor.js";
import type { EnvironmentTokens } from "./environment-tokens.js";
import type { ExecutionAccess } from "./execution.js";
import { mcpAuthorization } from "./mcp.js";

/** Signed Actor identity and per-call authorization on the Agent data path. */
export function executionRuntime(
  execution: ExecutionAccess,
  clients: KagentClients,
  workspace: string,
  access: BindingView,
  environmentToken: EnvironmentTokens,
  metadata: ToolMetadata,
  log?: Pick<FastifyBaseLogger, "error">,
) {
  const { registry, agentRole } = execution;
  const workspaces = new Set<string>(
    JSON.parse(process.env.AGENTOS_EXECUTION_WORKSPACES ?? JSON.stringify([workspace])),
  );
  if (!workspaces.has(workspace)) throw new Error("Execution workspace is missing");
  const issuer = requiredEnv("AGENTOS_ACTOR_ISSUER");
  const audience = JSON.parse(requiredEnv("AGENTOS_ACTOR_AUDIENCES")) as string[];
  if (
    !Array.isArray(audience) ||
    !audience.length ||
    !audience.every((entry) => typeof entry === "string")
  )
    throw new Error("Runtime audiences are required");
  const substrate = createClient(
    Control,
    createGrpcTransport({
      baseUrl: requiredEnv("AGENTOS_SUBSTRATE_URL"),
      nodeOptions: { ca: readFileSync(requiredEnv("AGENTOS_RUNTIME_CA")) },
      interceptors: [
        (next) => (request) => {
          request.header.set(
            "Authorization",
            `Bearer ${readFileSync(requiredEnv("AGENTOS_RUNTIME_TOKEN"), "utf8").trim()}`,
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
  const route = async (target: { serviceNames: string[]; metadataContext?: JsonObject }) => {
    const environment = text(target.metadataContext?.environment);
    const identity = text(target.metadataContext?.identity);
    const policy = await access();
    if (!policy.connection(target.serviceNames, environment, identity))
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
  return {
    ...execution,
    issuer,
    actorKeys: async () => {
      await keys.reload();
      return keys.jwks();
    },
    actor,
    authenticatedActor,
    resolve,
    guardrails,
    authorizeTransport,
  };
}

export type ExecutionRuntime = ReturnType<typeof executionRuntime>;
