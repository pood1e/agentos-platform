import { readFileSync } from "node:fs";
import type { IncomingHttpHeaders } from "node:http";
import { fromJsonString } from "@bufbuild/protobuf";
import {
  createLocalJWKSet,
  createRemoteJWKSet,
  decodeJwt,
  type JSONWebKeySet,
  jwtVerify,
} from "jose";
import { discovery } from "openid-client";
import {
  type WorkloadAuthentication,
  WorkloadAuthenticationSchema,
} from "../../gen/agentos/authorization/v1/workload_pb.js";
import { discoveryMethods } from "./mcp.js";

const bearer = (headers: IncomingHttpHeaders) => {
  const value = headers.authorization;
  if (typeof value !== "string" || !/^Bearer [^\s,]+$/.test(value))
    throw new Error("A signed workload identity is required");
  return value.slice(7);
};

export function workloadConfiguration() {
  const path = process.env.AGENTOS_WORKLOAD_AUTH_CONFIG;
  if (!path) throw new Error("AGENTOS_WORKLOAD_AUTH_CONFIG is required");
  return fromJsonString(WorkloadAuthenticationSchema, readFileSync(path, "utf8"));
}

/** Workload authentication does not grant a user execution or tool authority. */
export function workloadIdentity(config: WorkloadAuthentication) {
  if (
    !config.kubernetesIssuer ||
    !config.kubernetesJwks ||
    !config.controllerSubject ||
    !config.platformSubject ||
    !config.modelAudience ||
    !config.mcpAudience
  )
    throw new Error("Kubernetes workload trust is incomplete");
  const keys = createLocalJWKSet(config.kubernetesJwks as unknown as JSONWebKeySet);
  const providers = new Map<string, Promise<ReturnType<typeof createRemoteJWKSet>>>();
  async function kubernetes(headers: IncomingHttpHeaders, audience: string, subject: string) {
    const { payload } = await jwtVerify(bearer(headers), keys, {
      issuer: config.kubernetesIssuer,
      audience,
      algorithms: ["RS256", "ES256"],
      requiredClaims: ["iss", "sub", "aud", "exp", "iat"],
    });
    if (payload.sub !== subject) throw new Error("Workload subject does not match");
    return payload;
  }
  return {
    config,
    async controller(headers: IncomingHttpHeaders, method: string) {
      if (!discoveryMethods.has(method)) throw new Error("Discovery token cannot execute tools");
      await kubernetes(headers, "agentos-mcp-discovery", config.controllerSubject);
    },
    model: (headers: IncomingHttpHeaders) =>
      kubernetes(headers, config.modelAudience, config.platformSubject),
    async automation(headers: IncomingHttpHeaders) {
      const token = bearer(headers),
        claims = decodeJwt(token);
      const source = config.automationSources.find(
        (item) =>
          item.issuer === claims.iss && item.clientId === claims.azp && item.subject === claims.sub,
      );
      if (!source?.environment || !source.audience)
        throw new Error("Automation source is not registered");
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
        throw new Error("Automation identity does not match");
      return source;
    },
  };
}
export type WorkloadIdentity = ReturnType<typeof workloadIdentity>;
