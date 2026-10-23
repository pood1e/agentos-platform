import { randomBytes } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { Code } from "@connectrpc/connect";
import Fastify from "fastify";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import * as oidc from "openid-client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SessionSchema } from "../gen/kagent/api/v1/sessions_pb.js";
import { registerBrowserIdentity } from "../server/authorization/browser.js";
import { executions } from "../server/authorization/executions.js";
import { offlineCredentials } from "../server/authorization/offline.js";
import { jwtIdentity } from "../server/authorization/oidc.js";
import { memoryStore } from "./fixtures/execution-store.js";

const issuer = "https://identity.test/realm";
const origin = "https://console.test";
const keys = await generateKeyPair("RS256");
const jwk = { ...(await exportJWK(keys.publicKey)), kid: "test", alg: "RS256" };
const verify = jwtIdentity(
  { issuer, audience: "platform", writerRole: "writer", origin },
  createLocalJWKSet({ keys: [jwk] }),
);
const session = (id: string) =>
  create(SessionSchema, { id, agent: { name: "assistant", namespace: "workspace" } });
let writes = false;
let revoked = false;
let subject = "alice";
let refreshes = 0;
let nonce = "";
async function accessToken(audience = "platform", extra = {}) {
  return new SignJWT({ roles: writes ? ["writer"] : [], ...extra })
    .setProtectedHeader({ alg: "RS256", kid: "test" })
    .setIssuer(issuer)
    .setSubject(subject)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime("120s")
    .sign(keys.privateKey);
}
function client() {
  const config = new oidc.Configuration(
    {
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      jwks_uri: `${issuer}/keys`,
    },
    "console",
    "client-secret",
  );
  config[oidc.customFetch] = async (_url, init) => {
    if (String(_url).endsWith("/keys")) return Response.json({ keys: [jwk] });
    const form = new URLSearchParams(String(init?.body));
    if (form.get("grant_type") === "refresh_token") {
      refreshes++;
      expect(form.get("refresh_token")).toMatch(/^offline-/);
      if (revoked) return Response.json({ error: "invalid_grant" }, { status: 400 });
    } else {
      expect(form.get("grant_type")).toBe("authorization_code");
      expect(form.get("code_verifier")).toBeTruthy();
    }
    return Response.json({
      access_token: await accessToken(),
      token_type: "Bearer",
      expires_in: 120,
      refresh_token: `offline-${refreshes}`,
      scope: "openid offline_access",
      ...(nonce ? { id_token: await accessToken("console", { nonce }) } : {}),
    });
  };
  return config;
}
beforeEach(() => {
  writes = false;
  revoked = false;
  subject = "alice";
  refreshes = 0;
  nonce = "";
});
afterEach(() => vi.useRealTimers());

async function setup() {
  const store = memoryStore();
  const oauth = client();
  const grants = offlineCredentials(store, oauth, verify);
  const registry = executions(store, verify, undefined, grants.resolve);
  const identity = await grants.accept({
    access_token: await accessToken(),
    token_type: "bearer",
    refresh_token: "offline-initial",
    scope: "offline_access",
  });
  await registry.bind(session("root"), identity);
  await registry.bind(session("child"), identity, session("root"));
  return { store, oauth, grants, registry, identity };
}

it("keeps background delegation after browser logout and access-token expiry without elevating the original ceiling", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const { store, grants, registry, oauth } = await setup();
  const app = Fastify();
  await registerBrowserIdentity(app, {
    origin,
    client: oauth,
    key: randomBytes(32),
    grants,
    executions: registry,
  });
  await app.ready();
  try {
    const cookie = `__Host-agentos=${encodeURIComponent(app.encodeSecureSession(app.createSecureSession({ subject: `${issuer}#alice` })))}`;
    const result = await app.inject({
      method: "POST",
      url: "/auth/logout",
      headers: { origin, cookie },
    });
    expect(result.statusCode).toBe(204);
    expect(result.headers["set-cookie"]).toContain("Max-Age=0");
    writes = true;
    vi.setSystemTime(Date.now() + 180_000);
    const restarted = executions(
      store,
      verify,
      undefined,
      offlineCredentials(store, oauth, verify).resolve,
    );
    const execution = await restarted.resolve(session("child"));
    expect(execution.identity.subject).toBe(`${issuer}#alice`);
    expect(execution.write).toBe(false);
    expect(refreshes).toBe(1);
    await restarted.revoke(session("root"), execution.identity);
    await expect(restarted.resolve(session("child"))).rejects.toMatchObject({
      code: Code.PermissionDenied,
    });
    expect(refreshes).toBe(1);
  } finally {
    await app.close();
  }
});

it("rejects revoked offline grants and changed subjects without substituting a service account", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const { registry } = await setup();
  vi.setSystemTime(Date.now() + 180_000);
  revoked = true;
  await expect(registry.resolve(session("child"))).rejects.toMatchObject({
    code: Code.Unauthenticated,
  });
  revoked = false;
  subject = "bob";
  await expect(registry.resolve(session("child"))).rejects.toMatchObject({
    code: Code.PermissionDenied,
  });
});

it("uses authorization code with PKCE, state and nonce and keeps the offline credential outside cookies", async () => {
  const { grants, registry, oauth } = await setup();
  const app = Fastify();
  await registerBrowserIdentity(app, {
    origin,
    client: oauth,
    key: randomBytes(32),
    grants,
    executions: registry,
  });
  app.get("/private", async (request) => ({ token: request.headers["x-forwarded-access-token"] }));
  try {
    const start = await app.inject({ url: "/auth/start" });
    const url = new URL(String(start.headers.location));
    expect(url.searchParams.get("scope")).toContain("offline_access");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    nonce = url.searchParams.get("nonce") ?? "";
    const cookie = String(start.headers["set-cookie"]).split(";")[0];
    const callback = await app.inject({
      url: `/auth/callback?code=one&state=${url.searchParams.get("state")}`,
      headers: { cookie },
    });
    expect(callback.statusCode).toBe(302);
    const value = callback.cookies[0].value;
    const data = app.decodeSecureSession(value)?.data();
    expect(data).toMatchObject({ subject: `${issuer}#alice` });
    expect(JSON.stringify(data)).not.toContain("offline-");
    const privateResponse = await app.inject({
      url: "/private",
      headers: {
        cookie: `__Host-agentos=${encodeURIComponent(value)}`,
        "x-forwarded-access-token": "forged",
      },
    });
    expect(privateResponse.statusCode).toBe(200);
    expect(privateResponse.json().token).not.toBe("forged");
    const forged = await app.inject({
      url: "/auth/callback?code=two&state=forged",
      headers: { cookie },
    });
    expect(forged.statusCode).toBe(401);
  } finally {
    await app.close();
  }
});
