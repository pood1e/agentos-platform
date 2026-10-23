import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { createRemoteJWKSet, type JWTVerifyGetKey, jwtVerify } from "jose";
import { type Configuration, discovery } from "openid-client";
import { ExecutionIdentitySchema } from "../../gen/agentos/execution/v1/identity_pb.js";
import { roleCapabilities } from "../../shared/permissions.js";

export interface OIDCIdentityConfig {
  issuer: string;
  audience: string;
  writerRole: string;
  origin: string;
}

export function jwtIdentity(config: OIDCIdentityConfig, keys: JWTVerifyGetKey) {
  return async (headers: Headers) => {
    const forwarded = headers.get("x-forwarded-access-token");
    const authorization = headers.get("authorization");
    const token = forwarded ?? authorization?.match(/^Bearer ([^\s,]+)$/)?.[1];
    if (!token || /[\s,]/.test(token))
      throw new ConnectError("Authentication required", Code.Unauthenticated);
    try {
      const { payload } = await jwtVerify(token, keys, {
        issuer: config.issuer,
        audience: config.audience,
        algorithms: ["RS256", "PS256", "ES256"],
        requiredClaims: ["iss", "sub", "aud", "exp", "iat"],
      });
      if (typeof payload.sub !== "string" || !payload.sub.trim())
        throw new Error("Missing subject");
      return create(ExecutionIdentitySchema, {
        subject: `${config.issuer}#${payload.sub}`,
        write: Array.isArray(payload.roles) && payload.roles.includes(config.writerRole),
        capabilities: roleCapabilities(payload.roles),
        credential: { case: "accessToken", value: token },
      });
    } catch {
      throw new ConnectError("Authentication is invalid or expired", Code.Unauthenticated);
    }
  };
}

export async function oidcIdentity(config: OIDCIdentityConfig, client?: Configuration) {
  if (new URL(config.issuer).protocol !== "https:") throw new Error("OIDC requires HTTPS");
  if (new URL(config.origin).origin !== config.origin)
    throw new Error("A browser origin is required");
  if (!config.audience || !config.writerRole)
    throw new Error("OIDC audience and writer role required");
  const metadata = (
    client ?? (await discovery(new URL(config.issuer), config.audience))
  ).serverMetadata();
  if (!metadata.jwks_uri || new URL(metadata.jwks_uri).protocol !== "https:")
    throw new Error("OIDC signing keys require HTTPS");
  return jwtIdentity(config, createRemoteJWKSet(new URL(metadata.jwks_uri)));
}
