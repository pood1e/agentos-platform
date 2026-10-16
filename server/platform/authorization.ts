import { readFileSync } from "node:fs";
import { create, fromJsonString } from "@bufbuild/protobuf";
import { Code, ConnectError, createContextKey, type Interceptor } from "@connectrpc/connect";
import { createRemoteJWKSet, type JWTVerifyGetKey, jwtVerify } from "jose";
import {
  AccessProfileSchema,
  type AuthorizationConfig,
  AuthorizationConfigSchema,
} from "../../gen/agentos/console/v1/access_pb.js";

export const accessProfile = createContextKey(create(AccessProfileSchema));

const operatorMethods = new Set(["SendMessage", "RespondInteraction", "SubmitFeedback"]);
const readerMethods = new Set([
  "GetAccessProfile",
  "ListEngineers",
  "ListTasks",
  "WatchTask",
  "GetTaskRun",
  "ListConversations",
  "WatchConversation",
  "GetConfiguration",
  "GetPack",
  "ExplainTools",
  "ListChanges",
  "GetSchemas",
  "ListConnections",
  "ListSkills",
  "ListKnowledge",
  "SearchKnowledge",
  "ListEnvironments",
  "ListHarnesses",
  "GetEngineerRuntime",
  "ListCandidates",
  "GetCandidate",
  "SearchEvents",
  "GetEvent",
  "GetMetrics",
]);

export function authorizationConfig(env = process.env): AuthorizationConfig | undefined {
  if (env.AGENTOS_AUTH_DISABLED_FOR_TESTS === "true") {
    if (env.NODE_ENV === "production" || (env.AGENTOS_HOST && env.AGENTOS_HOST !== "127.0.0.1"))
      throw new Error("Test authentication bypass requires a local development server");
    return undefined;
  }
  if (!env.AGENTOS_AUTH_CONFIG || !env.AGENTOS_OIDC_AUDIENCE)
    throw new Error("AGENTOS_AUTH_CONFIG and AGENTOS_OIDC_AUDIENCE are required");
  const config = fromJsonString(
    AuthorizationConfigSchema,
    readFileSync(env.AGENTOS_AUTH_CONFIG, "utf8"),
  );
  config.audience = env.AGENTOS_OIDC_AUDIENCE;
  if (!config.issuer || !config.jwksUrl || !config.audience)
    throw new Error("OIDC issuer, JWKS URL and audience are required");
  return config;
}

/** Browser identity is verified independently of gateway machine credentials. */
export function humanAuthorization(
  workspace: string,
  config: AuthorizationConfig | undefined,
  keys: JWTVerifyGetKey | undefined = config
    ? createRemoteJWKSet(new URL(config.jwksUrl))
    : undefined,
): Interceptor {
  return (next) => async (request) => {
    let profile = create(AccessProfileSchema, {
      workspace,
      subject: "local-test",
      operate: true,
      manage: true,
    });
    if (config && keys) {
      const authorization = request.header.get("authorization") ?? "";
      if (!authorization.startsWith("Bearer "))
        throw new ConnectError("Authentication required", Code.Unauthenticated);
      const { payload } = await jwtVerify(authorization.slice(7), keys, {
        issuer: config.issuer,
        audience: config.audience,
        requiredClaims: ["sub", "exp"],
      }).catch(() => {
        throw new ConnectError("Invalid identity", Code.Unauthenticated);
      });
      const claim = payload[config.groupClaim || "groups"];
      const groups = Array.isArray(claim)
        ? claim.filter((value): value is string => typeof value === "string")
        : [];
      const member = (allowed: string[]) => allowed.some((group) => groups.includes(group));
      const manage = member(config.administratorGroups);
      const operate = manage || member(config.operatorGroups);
      if (!operate && !member(config.viewerGroups))
        throw new ConnectError("Workspace access denied", Code.PermissionDenied);
      profile = create(AccessProfileSchema, { workspace, subject: payload.sub, operate, manage });
    }
    if (
      (operatorMethods.has(request.method.name) && !profile.operate) ||
      (!readerMethods.has(request.method.name) &&
        !operatorMethods.has(request.method.name) &&
        !profile.manage)
    )
      throw new ConnectError("Permission denied", Code.PermissionDenied);
    request.contextValues.set(accessProfile, profile);
    return next(request);
  };
}
