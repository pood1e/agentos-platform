import { randomBytes } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { Code, createClient, createRouterTransport } from "@connectrpc/connect";
import Fastify from "fastify";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import * as oidc from "openid-client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ConsoleService } from "../gen/agentos/console/v1/console_service_pb.js";
import { PackSchema } from "../gen/agentos/console/v1/pack_pb.js";
import { SessionSchema } from "../gen/kagent/api/v1/sessions_pb.js";
import { registerDelegation } from "../server/authorization/delegation.js";
import { executions } from "../server/authorization/executions.js";
import { offlineCredentials } from "../server/authorization/offline.js";
import { jwtIdentity } from "../server/authorization/oidc.js";
import { consoleService } from "../server/console/service.js";
import { workspaceContext } from "../server/platform/access.js";
import { memoryStore } from "./fixtures/execution-store.js";
import { environment, testBindings } from "./harness.js";

const issuer = "https://identity.test/realm";
const origin = "https://api.test";
const consoleOrigin = "https://console.test";
const keys = await generateKeyPair("RS256");
const jwk = { ...(await exportJWK(keys.publicKey)), kid: "test", alg: "RS256" };
const verify = jwtIdentity(
  { issuer, audience: "platform", writerRole: "writer" },
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

it("keeps background delegation after access-token expiry without elevating the original ceiling", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const { store, oauth } = await setup();
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

it("does not lock valid credentials and coalesces concurrent refreshes", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const { store, grants } = await setup();
  const update = vi.spyOn(store, "updateIdentity");
  await Promise.all(Array.from({ length: 12 }, () => grants.resolve(`${issuer}#alice`)));
  expect(update).not.toHaveBeenCalled();
  vi.setSystemTime(Date.now() + 180_000);
  await Promise.all(Array.from({ length: 12 }, () => grants.resolve(`${issuer}#alice`)));
  expect(refreshes).toBe(1);
  expect(update).toHaveBeenCalledOnce();
});

it("delegates with authorization code, PKCE, state and nonce and returns only to registered clients", async () => {
  const store = memoryStore();
  const oauth = client();
  const grants = offlineCredentials(store, oauth, verify);
  const registry = executions(store, verify, undefined, grants.resolve);
  const app = Fastify();
  await registerDelegation(app, {
    origin,
    returnOrigins: [consoleOrigin],
    client: oauth,
    key: randomBytes(32),
    grants,
    executions: registry,
  });
  try {
    const foreign = await app.inject({
      url: `/delegation/start?return_to=${encodeURIComponent("https://evil.test/")}`,
    });
    expect(foreign.statusCode).toBe(400);
    const returnTo = `${consoleOrigin}/tasks?id=1`;
    const start = await app.inject({
      url: `/delegation/start?return_to=${encodeURIComponent(returnTo)}`,
    });
    const url = new URL(String(start.headers.location));
    expect(url.searchParams.get("scope")).toContain("offline_access");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("redirect_uri")).toBe(`${origin}/delegation/callback`);
    nonce = url.searchParams.get("nonce") ?? "";
    const cookie = String(start.headers["set-cookie"]).split(";")[0];
    expect(cookie).toMatch(/^__Host-agentos-delegation=/);
    expect(await registry.delegated(`${issuer}#alice`)).toBe(false);
    const forged = await app.inject({
      url: "/delegation/callback?code=two&state=forged",
      headers: { cookie },
    });
    expect(forged.statusCode).toBe(401);
    const restarted = await app.inject({
      url: `/delegation/start?return_to=${encodeURIComponent(returnTo)}`,
    });
    const state = new URL(String(restarted.headers.location)).searchParams;
    nonce = state.get("nonce") ?? "";
    const callback = await app.inject({
      url: `/delegation/callback?code=one&state=${state.get("state")}`,
      headers: { cookie: String(restarted.headers["set-cookie"]).split(";")[0] },
    });
    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toBe(returnTo);
    expect(String(callback.headers["set-cookie"])).not.toContain("offline-");
    expect(await registry.delegated(`${issuer}#alice`)).toBe(true);
  } finally {
    await app.close();
  }
});

it("asks users without an offline grant to delegate before starting executions", async () => {
  const env = await environment([]);
  const store = memoryStore();
  const registry = executions(store, verify);
  const api = createClient(
    ConsoleService,
    createRouterTransport(
      (router) =>
        router.service(
          ConsoleService,
          consoleService({
            ...env,
            namespace: "workspace",
            access: testBindings(env.fake),
            executions: registry,
            operations: { $typeName: "agentos.governance.v1.GovernanceConfig", environments: [] },
            roleDefaults: { modelConfig: "default-model-config", harness: "standard" },
            replaceTemplate: async (value) => env.fake.replaceTemplate(value),
            pack: create(PackSchema),
            delegationUrl: `${origin}/delegation/start`,
          }),
        ),
      {
        router: {
          interceptors: [workspaceContext("workspace", "assistant", verify, registry.remember)],
        },
      },
    ),
  );
  const headers = { authorization: `Bearer ${await accessToken()}` };
  try {
    expect((await api.getAccessProfile({}, { headers })).profile).toMatchObject({
      delegated: false,
      delegationUrl: `${origin}/delegation/start`,
    });
    await expect(
      api.sendMessage({ agent: { namespace: "workspace", name: "assistant" } }, { headers }),
    ).rejects.toMatchObject({ code: Code.FailedPrecondition, rawMessage: "delegation.required" });
    await registry.remember(
      await offlineCredentials(store, client(), verify).accept({
        access_token: await accessToken(),
        token_type: "bearer",
        refresh_token: "offline-initial",
        scope: "offline_access",
      }),
      true,
    );
    expect((await api.getAccessProfile({}, { headers })).profile?.delegated).toBe(true);
  } finally {
    await env.close();
  }
});
