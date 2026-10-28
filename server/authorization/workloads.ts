import { readFileSync } from "node:fs";
import type { IncomingHttpHeaders } from "node:http";
import { fromJsonString } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { type AuthenticationV1Api, createConfiguration } from "@kubernetes/client-node";
import { createRemoteJWKSet, decodeJwt, jwtVerify } from "jose";
import { discovery } from "openid-client";
import {
  type WorkloadAuthentication,
  WorkloadAuthenticationSchema,
} from "../../gen/agentos/authorization/v1/workload_pb.js";
import { discoveryMethods } from "./mcp.js";

const bearer = (headers: IncomingHttpHeaders) => {
  const value = headers.authorization;
  if (typeof value !== "string" || !/^Bearer [^\s,]+$/.test(value))
    throw new ConnectError("A signed workload identity is required", Code.Unauthenticated);
  return value.slice(7);
};

export function workloadConfiguration() {
  const path = process.env.AGENTOS_WORKLOAD_AUTH_CONFIG;
  if (!path) throw new Error("AGENTOS_WORKLOAD_AUTH_CONFIG is required");
  return fromJsonString(WorkloadAuthenticationSchema, readFileSync(path, "utf8"));
}

/** TokenReview of a projected service account token issued for one audience. */
export function serviceAccountTokens(api: Pick<AuthenticationV1Api, "createTokenReview">) {
  const { middleware } = createConfiguration({
    promiseMiddleware: [
      {
        async pre(request) {
          request.setSignal(AbortSignal.timeout(5_000));
          return request;
        },
        post: async (response) => response,
      },
    ],
  });
  return async (token: string, audience: string, subjects: string[]) => {
    const { status } = await api.createTokenReview(
      {
        body: {
          apiVersion: "authentication.k8s.io/v1",
          kind: "TokenReview",
          spec: { token, audiences: [audience] },
        },
      },
      { middleware, middlewareMergeStrategy: "append" },
    );
    if (
      !status?.authenticated ||
      !status.audiences?.includes(audience) ||
      !subjects.includes(status.user?.username ?? "")
    )
      throw new ConnectError("Workload identity is invalid", Code.Unauthenticated);
  };
}

/** Workload authentication does not grant a user execution or tool authority. */
export function workloadIdentity(
  config: WorkloadAuthentication,
  api: Pick<AuthenticationV1Api, "createTokenReview">,
) {
  if (
    !config.controllerSubject ||
    !config.platformSubjects.length ||
    !config.modelAudience ||
    !config.mcpAudience
  )
    throw new Error("Kubernetes workload trust is incomplete");
  const review = serviceAccountTokens(api);
  const providers = new Map<string, Promise<ReturnType<typeof createRemoteJWKSet>>>();
  const kubernetes = (headers: IncomingHttpHeaders, audience: string, subjects: string[]) =>
    review(bearer(headers), audience, subjects);
  return {
    config,
    async controller(headers: IncomingHttpHeaders, method: string) {
      if (!discoveryMethods.has(method))
        throw new ConnectError("Discovery token cannot execute tools", Code.PermissionDenied);
      await kubernetes(headers, "agentos-mcp-discovery", [config.controllerSubject]);
    },
    model: (headers: IncomingHttpHeaders) =>
      kubernetes(headers, config.modelAudience, config.platformSubjects),
    async automation(headers: IncomingHttpHeaders) {
      const token = bearer(headers),
        claims = decodeJwt(token);
      const source = config.automationSources.find(
        (item) =>
          item.issuer === claims.iss && item.clientId === claims.azp && item.subject === claims.sub,
      );
      if (!source?.environment || !source.audience)
        throw new ConnectError("Automation source is not registered", Code.PermissionDenied);
      let pending = providers.get(source.issuer);
      if (!pending) {
        const issuer = source.issuer;
        if (new URL(issuer).protocol !== "https:")
          throw new Error("Automation issuer requires HTTPS");
        pending = discovery(new URL(issuer), source.clientId)
          .then((client) => {
            const url = client.serverMetadata().jwks_uri;
            if (!url || new URL(url).protocol !== "https:")
              throw new Error("Signing keys require HTTPS");
            return createRemoteJWKSet(new URL(url));
          })
          .catch((error) => {
            providers.delete(issuer);
            throw error;
          });
        providers.set(issuer, pending);
      }
      const { payload } = await jwtVerify(token, await pending, {
        issuer: source.issuer,
        audience: source.audience,
        algorithms: ["RS256", "PS256", "ES256"],
        requiredClaims: ["iss", "sub", "aud", "exp", "iat", "azp"],
      });
      if (payload.azp !== source.clientId || payload.sub !== source.subject)
        throw new ConnectError("Automation identity does not match", Code.PermissionDenied);
      return source;
    },
  };
}
export type WorkloadIdentity = ReturnType<typeof workloadIdentity>;
