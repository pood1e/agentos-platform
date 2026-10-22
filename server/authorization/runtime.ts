import { readFileSync } from "node:fs";
import { create, type JsonObject } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { createRemoteJWKSet } from "jose";
import {
  HeaderMutationSchema,
  McpHeaderSchema,
} from "../../gen/agentgateway/dev/ext_mcp/ext_mcp_pb.js";
import { Control } from "../../gen/ateapi_pb.js";
import type { Session } from "../../gen/kagent/api/v1/sessions_pb.js";
import { scheduledIdentity } from "../automation/identity.js";
import { roleDefinition } from "../console/role-template.js";
import type { BindingView } from "../governance/bindings.js";
import type { KagentClients } from "../kagent/clients.js";
import { agentInfo } from "../read-model/agents.js";
import { object, text } from "../read-model/decode/messages.js";
import { toolBaseName } from "../read-model/decode/tools.js";
import { actorTokenHeader, actorVerifier, runtimeIdentity } from "./actor.js";
import { executions } from "./executions.js";
import { mcpAuthorization } from "./mcp.js";
import type { jwtIdentity } from "./oidc.js";
import { executionStore } from "./store.js";

export const executionKindHeader = "x-agentos-execution-kind";
export const subjectTokenHeader = "x-agentos-subject-token";

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
) {
  const persistent = await executionStore(
    required("AGENTOS_EXECUTION_DATABASE_URL"),
    Buffer.from(required("AGENTOS_EXECUTION_KEY"), "base64"),
    workspace,
    process.env.AGENTOS_EXECUTION_DATABASE_CA
      ? readFileSync(process.env.AGENTOS_EXECUTION_DATABASE_CA, "utf8")
      : undefined,
  );
  const registry = executions(
    persistent,
    verify,
    nativeCreator ? scheduledIdentity(clients, workspace, nativeCreator) : undefined,
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
  const actor = async (headers: Record<string, string | string[] | undefined>) => {
    const bearer = headers[actorTokenHeader];
    if (typeof bearer !== "string" || !/^Bearer [^\s,]+$/.test(bearer))
      throw new Error("Signed runtime identity required");
    return resolve(bearer.slice(7));
  };
  const authenticatedActor = async (headers: Headers) => {
    const bearer = headers.get("authorization");
    if (!bearer || !/^Bearer [^\s,]+$/.test(bearer))
      throw new Error("Signed runtime identity required");
    return { session: await resolveRuntime(bearer.slice(7)) };
  };
  const agentRole = async (session: Session) => {
    const { agent } = await clients.agents.getAgent({ ref: session.agent }, { timeoutMs: 5_000 });
    if (!agent) throw new ConnectError("Execution Agent is unavailable", Code.PermissionDenied);
    const reference = object(object(object(agent.resource?.value?.spec).template).ref);
    const { agentTemplate } = await clients.templates.getAgentTemplate(
      {
        ref: {
          namespace: text(reference.namespace) || session.agent?.namespace,
          name: text(reference.name),
        },
      },
      { timeoutMs: 5_000 },
    );
    if (!agentTemplate)
      throw new ConnectError("Execution template is unavailable", Code.PermissionDenied);
    return { engineer: agentInfo(agent).role, role: roleDefinition(agentTemplate) };
  };
  const guardrails = mcpAuthorization(
    resolve,
    async (session, tool, target) => {
      const context = await registry.resolve(session);
      const { engineer, role } = await agentRole(session);
      const policy = await access();
      if (
        !policy.selectedCall(role.tools, target.serviceNames, tool.name) ||
        !policy.permitsCall(engineer, target.serviceNames, tool.name, context.write)
      )
        throw new ConnectError(
          "Tool is outside the user's execution permissions",
          Code.PermissionDenied,
        );
      const headers = [
        create(McpHeaderSchema, {
          key: executionKindHeader,
          value: new TextEncoder().encode(
            context.identity.credential.case === "accessToken" ? "user" : "service",
          ),
        }),
      ];
      if (context.identity.credential.case === "accessToken")
        headers.push(
          create(McpHeaderSchema, {
            key: subjectTokenHeader,
            value: new TextEncoder().encode(`Bearer ${context.identity.credential.value}`),
          }),
        );
      return {
        headerMutation: create(HeaderMutationSchema, {
          set: headers,
          remove: context.identity.credential.case === "accessToken" ? [] : [subjectTokenHeader],
        }),
        metadata: {
          initiator: context.identity.subject,
          sessionId: session.id,
          rootSessionId: context.binding.rootSessionId,
        } as JsonObject,
      };
    },
    create(HeaderMutationSchema, {
      set: [
        create(McpHeaderSchema, {
          key: executionKindHeader,
          value: new TextEncoder().encode("service"),
        }),
      ],
      remove: [subjectTokenHeader],
    }),
  );
  const authorizeTools = async (session: Session, tools: string[]) => {
    const context = await registry.resolve(session);
    const { engineer, role } = await agentRole(session);
    const bindings = await access();
    if (
      tools.some(
        (tool) =>
          !role.tools.some((binding) => binding.tools.includes(toolBaseName(tool))) ||
          !bindings.permitsTool(engineer, toolBaseName(tool), context.write),
      )
    )
      throw new ConnectError(
        "Tool is outside the user's execution permissions",
        Code.PermissionDenied,
      );
  };
  return {
    registry,
    actor,
    authenticatedActor,
    resolve,
    guardrails,
    authorizeTools,
    close: persistent.close,
  };
}

export type ExecutionRuntime = Awaited<ReturnType<typeof executionRuntime>>;
