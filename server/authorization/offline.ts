import { Code, ConnectError } from "@connectrpc/connect";
import { decodeJwt } from "jose";
import * as oidc from "openid-client";
import type { ExecutionIdentity } from "../../gen/agentos/execution/v1/identity_pb.js";
import type { jwtIdentity } from "./oidc.js";
import type { ExecutionStore } from "./store.js";

/** Offline grants outlive browser login; execution bindings retain their original ceiling. */
export function offlineCredentials(
  store: ExecutionStore,
  oauth: oidc.Configuration,
  verify: ReturnType<typeof jwtIdentity>,
) {
  const principal = async (tokens: oidc.TokenEndpointResponse) =>
    verify(new Headers({ authorization: `Bearer ${tokens.access_token}` }));

  return {
    async accept(tokens: oidc.TokenEndpointResponse): Promise<ExecutionIdentity> {
      if (!tokens.refresh_token || !tokens.scope?.split(" ").includes("offline_access"))
        throw new ConnectError(
          "Offline execution authorization is required",
          Code.PermissionDenied,
        );
      return { ...(await principal(tokens)), refreshToken: tokens.refresh_token };
    },
    resolve: (subject: string) =>
      store.updateIdentity(subject, async (saved) => {
        if (saved.credential.case !== "accessToken")
          throw new ConnectError("User delegation is unavailable", Code.PermissionDenied);
        const expiry = decodeJwt(saved.credential.value).exp ?? 0;
        if (expiry * 1000 > Date.now() + 30_000) {
          await principal({ access_token: saved.credential.value, token_type: "bearer" });
          return saved;
        }
        if (!saved.refreshToken)
          throw new ConnectError("User delegation requires renewed consent", Code.Unauthenticated);
        let tokens: oidc.TokenEndpointResponse;
        try {
          tokens = await oidc.refreshTokenGrant(oauth, saved.refreshToken);
        } catch {
          throw new ConnectError("User delegation expired or was revoked", Code.Unauthenticated);
        }
        const next = await principal(tokens);
        if (next.subject !== saved.subject)
          throw new ConnectError("User delegation subject changed", Code.PermissionDenied);
        return { ...next, refreshToken: tokens.refresh_token ?? saved.refreshToken };
      }),
  };
}

export type OfflineCredentials = ReturnType<typeof offlineCredentials>;
