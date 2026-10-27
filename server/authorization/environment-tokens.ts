import { createHash } from "node:crypto";
import { CoreV1Api, type KubeConfig } from "@kubernetes/client-node";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { LRUCache } from "lru-cache";
import * as oidc from "openid-client";
import type { ExecutionIdentity } from "../../gen/agentos/execution/v1/identity_pb.js";
import type { GovernanceConfig } from "../../gen/agentos/governance/v1/governance_pb.js";

interface ClientCredentials {
  clientId: string;
  clientSecret: string;
}

type Credentials = (environment: string, identity: string) => Promise<ClientCredentials>;

export function environmentCredentials(config: KubeConfig, namespace: string): Credentials {
  const api = config.makeApiClient(CoreV1Api);
  return async (environment, identity) => {
    const { data } = await api.readNamespacedSecret({
      namespace,
      name: `${environment}-${identity}`,
    });
    const clientId = Buffer.from(data?.["client-id"] ?? "", "base64").toString("utf8");
    const clientSecret = Buffer.from(data?.["client-secret"] ?? "", "base64").toString("utf8");
    if (clientId !== `agentos-${identity}` || !clientSecret)
      throw new Error("Environment client credentials are unavailable");
    return { clientId, clientSecret };
  };
}

/**
 * Callers resolve execution revocation and route ownership before requesting a token.
 * Without user token exchange, environments only trust the platform's service identities.
 */
export function environmentTokens(
  config: GovernanceConfig,
  credentials: Credentials,
  exchange = true,
) {
  const connections = new Map(config.environments.map((item) => [item.environment?.name, item]));
  const clients = new LRUCache<string, Promise<oidc.Configuration>>({ max: 128, ttl: 60_000 });
  const tokens = new LRUCache<string, { token: string; expires: number }>({ max: 512 });
  const pending = new Map<string, Promise<string>>();
  const keys = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
  return async (environment: string, identity: string, initiator?: ExecutionIdentity) => {
    const connection = connections.get(environment);
    if (!connection || !identity) throw new Error("Environment identity is unavailable");
    const subject =
      exchange && initiator?.credential.case === "accessToken" ? initiator.credential.value : "";
    const key = JSON.stringify([
      environment,
      identity,
      initiator?.subject ?? "discovery",
      createHash("sha256").update(subject).digest("hex"),
    ]);
    const cached = tokens.get(key);
    if (cached && cached.expires > Date.now() + 15_000) return cached.token;
    const active = pending.get(key);
    if (active) return active;
    const grant = async () => {
      const clientKey = JSON.stringify([environment, identity]);
      let client = clients.get(clientKey);
      if (!client) {
        client = credentials(environment, identity).then(({ clientId, clientSecret }) =>
          oidc.discovery(new URL(connection.issuer), clientId, clientSecret),
        );
        clients.set(clientKey, client);
      }
      try {
        const oauth = await client;
        const response = subject
          ? await oidc.genericGrantRequest(
              oauth,
              "urn:ietf:params:oauth:grant-type:token-exchange",
              {
                subject_token: subject,
                subject_token_type: "urn:ietf:params:oauth:token-type:access_token",
                requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
                audience: connection.resource,
              },
            )
          : await oidc.clientCredentialsGrant(oauth);
        const jwksUri = oauth.serverMetadata().jwks_uri;
        if (!jwksUri || new URL(jwksUri).protocol !== "https:")
          throw new Error("Environment signing keys require HTTPS");
        let jwks = keys.get(jwksUri);
        if (!jwks) {
          jwks = createRemoteJWKSet(new URL(jwksUri));
          keys.set(jwksUri, jwks);
        }
        const { payload } = await jwtVerify(response.access_token, jwks, {
          issuer: connection.issuer,
          audience: connection.resource,
          requiredClaims: ["sub", "exp", "azp"],
        });
        if (
          payload.azp !== `agentos-${identity}` ||
          response.token_type.toLowerCase() !== "bearer" ||
          typeof payload.exp !== "number" ||
          (subject && `${connection.issuer}#${payload.sub}` !== initiator?.subject)
        )
          throw new Error("Environment token identity mismatch");
        tokens.set(key, { token: response.access_token, expires: payload.exp * 1000 });
        return response.access_token;
      } catch (error) {
        clients.delete(clientKey);
        throw error;
      }
    };
    const result = grant();
    pending.set(key, result);
    try {
      return await result;
    } finally {
      pending.delete(key);
    }
  };
}

export type EnvironmentTokens = ReturnType<typeof environmentTokens>;
