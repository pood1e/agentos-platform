import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import Fastify, { type InjectOptions } from "fastify";
import { createRemoteJWKSet, customFetch as jwksFetch } from "jose";
import * as oidc from "openid-client";
import postgres from "postgres";
import { expect, it } from "vitest";
import { jwtIdentity } from "../server/authorization/oidc.js";
import { registerIdentity } from "../server/identity/login.js";
import { identityProvider } from "../server/identity/provider.js";
import { artifactStore } from "../server/identity/store.js";
import { allCapabilities } from "../shared/permissions.js";

const issuer = "http://identity.test/identity";
const callback = "http://api.test/delegation/callback";

it.skipIf(!process.env.CHANGE_TEST_DATABASE_URL)(
  "issues platform tokens for the site password, refreshes offline grants and limits failed sign-ins",
  async () => {
    const uri = process.env.CHANGE_TEST_DATABASE_URL ?? "";
    const store = await artifactStore(uri);
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const { provider, prefix } = await identityProvider(
      {
        issuer,
        audience: "agentos",
        writerRole: "agentos-writer",
        clientId: "agentos",
        clientSecret: "client-secret",
        redirectUris: [callback],
        signingKey: privateKey.export({ format: "pem", type: "sec1" }).toString(),
        cookieKey: randomBytes(32).toString("base64"),
      },
      store.adapter,
    );
    const app = Fastify();
    await registerIdentity(app, provider, prefix, "site-password");
    const jar = new Map<string, string>();
    const send = async (url: string, options: InjectOptions = {}) => {
      const response = await app.inject({
        ...options,
        url,
        headers: {
          host: "identity.test",
          cookie: [...jar].map(([name, value]) => `${name}=${value}`).join("; "),
          ...options.headers,
        },
      });
      for (const cookie of response.cookies)
        if (cookie.maxAge === 0 || (cookie.expires && cookie.expires < new Date()))
          jar.delete(cookie.name);
        else jar.set(cookie.name, cookie.value);
      return response;
    };
    const relay = async (
      input: string | URL,
      init?: { method?: string; headers?: HeadersInit; body?: unknown },
    ) => {
      const url = new URL(input);
      const response = await app.inject({
        method: (init?.method ?? "GET") as InjectOptions["method"],
        url: url.pathname + url.search,
        headers: { ...Object.fromEntries(new Headers(init?.headers)), host: url.host },
        payload: init?.body ? String(init.body) : undefined,
      });
      return new Response(new Uint8Array(response.rawPayload), {
        status: response.statusCode,
        headers: response.headers as Record<string, string>,
      });
    };
    const sql = postgres(uri, { max: 1 });
    try {
      const client = await oidc.discovery(new URL(issuer), "agentos", "client-secret", undefined, {
        [oidc.customFetch]: relay,
        execute: [oidc.allowInsecureRequests],
      });
      const verifier = oidc.randomPKCECodeVerifier(),
        state = oidc.randomState();
      const start = oidc.buildAuthorizationUrl(client, {
        redirect_uri: callback,
        scope: "openid offline_access",
        prompt: "consent",
        code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
        code_challenge_method: "S256",
        state,
      });
      let response = await send(start.pathname + start.search);
      const login = String(response.headers.location);
      expect(login).toMatch(new RegExp(`^${prefix}/interaction/`));
      expect((await send(login)).body).toContain('type="password"');
      const attempt = (password: string, remoteAddress = "203.0.113.7") =>
        send(login, {
          method: "POST",
          remoteAddress,
          headers: { "content-type": "application/x-www-form-urlencoded" },
          payload: new URLSearchParams({ password }).toString(),
        });
      for (let failure = 0; failure < 5; failure++)
        expect((await attempt("guess")).statusCode).toBe(401);
      expect((await attempt("site-password")).statusCode).toBe(429);
      response = await attempt("site-password", "198.51.100.4");
      for (let hop = 0; hop < 6 && !String(response.headers.location).startsWith(callback); hop++)
        response = await send(String(response.headers.location));
      const tokens = await oidc.authorizationCodeGrant(
        client,
        new URL(String(response.headers.location)),
        { pkceCodeVerifier: verifier, expectedState: state },
      );
      expect(tokens.scope?.split(" ")).toContain("offline_access");
      expect(tokens.refresh_token).toBeTruthy();
      const verify = jwtIdentity(
        { issuer, audience: "agentos", writerRole: "agentos-writer" },
        createRemoteJWKSet(new URL(`${issuer}/jwks`), { [jwksFetch]: relay }),
      );
      const identity = await verify(
        new Headers({ authorization: `Bearer ${tokens.access_token}` }),
      );
      expect(identity).toMatchObject({
        subject: `${issuer}#site`,
        write: true,
        capabilities: allCapabilities,
      });
      const refreshed = await oidc.refreshTokenGrant(client, tokens.refresh_token ?? "");
      expect(
        (await verify(new Headers({ authorization: `Bearer ${refreshed.access_token}` }))).subject,
      ).toBe(identity.subject);
      const [row] = await sql`select count(*)::int as count from agentos_identity.artifacts
        where model = 'RefreshToken'`;
      expect(row?.count).toBeGreaterThan(0);
      expect((await send(`${prefix}/interaction/${randomUUID()}`)).statusCode).toBe(400);
    } finally {
      await app.close();
      await Promise.all([sql.end(), store.close()]);
    }
  },
);
