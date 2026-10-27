import { createPrivateKey } from "node:crypto";
import { calculateJwkThumbprint, type JWK } from "jose";
import Provider, { type Adapter, errors } from "oidc-provider";
import { allCapabilities, capabilityRole } from "../../shared/permissions.js";

export interface IdentityConfig {
  issuer: string;
  audience: string;
  writerRole: string;
  clientId: string;
  clientSecret: string;
  redirectUris: string[];
  signingKey: string;
  cookieKey: string;
}

/** The single shared account that the site password unlocks. */
export const siteAccount = "site";

const day = 24 * 3600;
/** Resource indicators are absolute URIs; tokens for it carry the platform audience. */
const platformResource = "urn:agentos:platform";

export async function identityProvider(
  config: IdentityConfig,
  adapter: (model: string) => Adapter,
) {
  const jwk = createPrivateKey(config.signingKey).export({ format: "jwk" }) as JWK;
  const roles = [config.writerRole, ...allCapabilities.map(capabilityRole)];
  const prefix = new URL(config.issuer).pathname.replace(/\/$/, "");
  const provider = new Provider(config.issuer, {
    adapter,
    clients: [
      {
        client_id: config.clientId,
        client_secret: config.clientSecret,
        redirect_uris: config.redirectUris,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        id_token_signed_response_alg: "ES256",
      },
    ],
    jwks: { keys: [{ ...jwk, alg: "ES256", use: "sig", kid: await calculateJwkThumbprint(jwk) }] },
    cookies: { keys: [config.cookieKey] },
    findAccount: (_ctx, sub) =>
      sub === siteAccount ? { accountId: sub, claims: () => ({ sub }) } : undefined,
    interactions: { url: (_ctx, interaction) => `${prefix}/interaction/${interaction.uid}` },
    features: {
      devInteractions: { enabled: false },
      resourceIndicators: {
        enabled: true,
        defaultResource: () => platformResource,
        useGrantedResource: () => true,
        getResourceServerInfo: (_ctx, indicator) => {
          if (indicator !== platformResource) throw new errors.InvalidTarget();
          return {
            // Token responses report access-token scopes; the platform requires offline access there.
            scope: "offline_access",
            audience: config.audience,
            accessTokenFormat: "jwt",
            accessTokenTTL: 300,
            jwt: { sign: { alg: "ES256" } },
          };
        },
      },
    },
    extraTokenClaims: () => ({ roles }),
    // Browser sessions refresh without offline access; offline grants outlive the session.
    issueRefreshToken: async (_ctx, client) => client.grantTypeAllowed("refresh_token"),
    pkce: { required: () => true },
    ttl: {
      AccessToken: 300,
      AuthorizationCode: 60,
      IdToken: 300,
      Interaction: 600,
      Session: 14 * day,
      Grant: 30 * day,
      RefreshToken: 30 * day,
    },
  });
  provider.proxy = true;
  return { provider, prefix };
}
