import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { lookup } from "node:dns";
import { readFileSync } from "node:fs";
import KeycloakAdminClient from "@keycloak/keycloak-admin-client";
import { createLocalJWKSet, jwtVerify } from "jose";
import { Configuration, genericGrantRequest, refreshTokenGrant } from "openid-client";
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import policy from "../../authorization/keycloak/realm-policy.json" with { type: "json" };

const baseUrl = process.env.PROOF_KEYCLOAK_URL;
const passwordFile = process.env.PROOF_KEYCLOAK_ADMIN_PASSWORD_FILE;
if (!baseUrl || !passwordFile) throw new Error("Keycloak URL and admin password file are required");
if (new URL(baseUrl).protocol !== "https:") throw new Error("Keycloak proof requires HTTPS");
const previousDispatcher = getGlobalDispatcher();
const dispatcher = new Agent({
  connect: {
    lookup: (host, options, callback) =>
      lookup(process.env.PROOF_KEYCLOAK_ADDRESS ?? host, options, callback),
  },
});
setGlobalDispatcher(dispatcher);
const realm = `agentos-authorization-proof-${randomUUID().slice(0, 8)}`;
const password = randomUUID();
const secret = randomUUID();
const admin = new KeycloakAdminClient({ baseUrl, realmName: "master" });
await admin.auth({
  grantType: "password",
  clientId: "admin-cli",
  username: process.env.PROOF_KEYCLOAK_ADMIN_USERNAME ?? "admin",
  password: readFileSync(passwordFile, "utf8").trim(),
});
let created = false;
try {
  await admin.realms.create({
    realm,
    enabled: true,
    sslRequired: "external",
    accessTokenLifespan: 300,
    registrationAllowed: false,
  });
  created = true;
  admin.setConfig({ realmName: realm });
  await admin.clientPolicies.createProfiles(policy.clientProfiles);
  await admin.clientPolicies.updatePolicy(policy.clientPolicies);
  await admin.clientScopes.create({
    name: "forbidden-scope",
    protocol: "openid-connect",
    attributes: { "include.in.token.scope": "true" },
  });
  const { id: consoleId } = await admin.clients.create({
    clientId: "console",
    protocol: "openid-connect",
    publicClient: true,
    enabled: true,
    directAccessGrantsEnabled: true,
    fullScopeAllowed: true,
    defaultClientScopes: ["basic", "roles"],
    optionalClientScopes: [],
  });
  await admin.clients.addProtocolMapper(
    { id: consoleId },
    {
      name: "broker-audience",
      protocol: "openid-connect",
      protocolMapper: "oidc-audience-mapper",
      config: { "included.client.audience": "agentos-broker", "access.token.claim": "true" },
    },
  );
  const { id: brokerId } = await admin.clients.create({
    clientId: "agentos-broker",
    protocol: "openid-connect",
    publicClient: false,
    secret,
    enabled: true,
    fullScopeAllowed: false,
    defaultClientScopes: ["basic", "roles"],
    optionalClientScopes: ["forbidden-scope"],
    attributes: { "standard.token.exchange.enabled": "true" },
  });
  const [management] = await admin.clients.find({ clientId: "realm-management" });
  assert(management?.id, "Native management client was not created");
  const readRole = await admin.clients.findRole({ id: management.id, roleName: "view-users" });
  const writeRole = await admin.clients.findRole({ id: management.id, roleName: "manage-users" });
  assert(readRole?.id && writeRole?.id, "Native management roles are missing");
  const { id: readScopeId } = await admin.clientScopes.create({
    name: "users:read",
    protocol: "openid-connect",
    attributes: { "include.in.token.scope": "true" },
  });
  await admin.clientScopes.addClientScopeMappings({ id: readScopeId, client: management.id }, [
    readRole,
  ]);
  for (const id of [consoleId, brokerId])
    await admin.clients.addDefaultClientScope({ id, clientScopeId: readScopeId });
  const users = new Map<string, string>();
  for (const username of ["alice", "bob"]) {
    const { id } = await admin.users.create({
      username,
      email: `${username}@example.test`,
      firstName: username,
      lastName: "Proof",
      emailVerified: true,
      enabled: true,
      credentials: [{ type: "password", value: password, temporary: false }],
    });
    users.set(username, id);
  }
  const aliceId = users.get("alice");
  assert(aliceId, "Alice fixture is missing");
  await admin.users.addClientRoleMappings({
    id: aliceId,
    clientUniqueId: management.id,
    roles: [
      { id: readRole.id, name: "view-users" },
      { id: writeRole.id, name: "manage-users" },
    ],
  });
  const metadataResponse = await fetch(
    `${baseUrl}/realms/${realm}/.well-known/openid-configuration`,
  );
  assert(metadataResponse.ok);
  const metadata = await metadataResponse.json();
  const endpoint = `${baseUrl}/realms/${realm}/protocol/openid-connect`;
  const keysResponse = await fetch(`${endpoint}/certs`);
  assert(keysResponse.ok);
  const keys = createLocalJWKSet(await keysResponse.json());
  const config = (id: string, credential?: string) => {
    const value = new Configuration(
      { ...metadata, token_endpoint: `${endpoint}/token` },
      id,
      credential,
    );
    value.timeout = 10;
    return value;
  };
  const verify = async (token: string, audience: string) =>
    (await jwtVerify(token, keys, { issuer: metadata.issuer, audience, algorithms: ["RS256"] }))
      .payload;
  const broker = config("agentos-broker", secret);
  const exchange = (token: string, audience = "realm-management", scope?: string) =>
    genericGrantRequest(broker, "urn:ietf:params:oauth:grant-type:token-exchange", {
      subject_token: token,
      subject_token_type: "urn:ietf:params:oauth:token-type:access_token",
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
      audience,
      ...(scope === undefined ? {} : { scope }),
    });
  const subject = await genericGrantRequest(config("console"), "password", {
    username: "alice",
    password,
    scope: "openid roles",
  });
  const original = await verify(subject.access_token, "agentos-broker");
  const exchanged = await exchange(subject.access_token);
  const claims = await verify(exchanged.access_token, "realm-management");
  assert.equal(claims.sub, original.sub);
  assert.equal(claims.sub, users.get("alice"));
  assert.equal(claims.azp, "agentos-broker");
  assert.equal(claims.aud, "realm-management");
  assert.deepEqual(claims.resource_access, {
    "realm-management": { roles: ["view-users", "query-groups", "query-users"] },
  });
  assert(!exchanged.refresh_token, "Ordinary exchange unexpectedly issued a refresh credential");
  const target = new KeycloakAdminClient({ baseUrl, realmName: realm });
  target.setAccessToken(exchanged.access_token);
  assert((await target.users.find({ max: 2 })).length > 0, "Native target refused the user token");
  await assert.rejects(
    target.users.create({ username: "forbidden", enabled: true }),
    (error) =>
      error instanceof Error &&
      "response" in error &&
      error.response instanceof Response &&
      error.response.status === 403,
  );
  await assert.rejects(exchange(subject.access_token, "console"), { error: "invalid_request" });
  await assert.rejects(exchange(subject.access_token, "realm-management", "forbidden-scope"), {
    error: "invalid_scope",
  });
  await assert.rejects(
    genericGrantRequest(config("console"), "urn:ietf:params:oauth:grant-type:token-exchange", {
      subject_token: subject.access_token,
      subject_token_type: "urn:ietf:params:oauth:token-type:access_token",
      audience: "realm-management",
    }),
    { error: "invalid_request" },
  );
  const bob = await genericGrantRequest(config("console"), "password", {
    username: "bob",
    password,
    scope: "openid roles",
  });
  await assert.rejects(exchange(bob.access_token), { error: "invalid_request" });
  assert(subject.refresh_token, "Login did not issue a refresh token");
  const renewed = await refreshTokenGrant(config("console"), subject.refresh_token);
  assert.equal((await verify(renewed.access_token, "agentos-broker")).sub, original.sub);
  await admin.users.logout({ id: aliceId });
  assert(renewed.refresh_token, "Refresh did not issue a successor credential");
  await assert.rejects(refreshTokenGrant(config("console"), renewed.refresh_token), {
    error: "invalid_grant",
  });
  console.log(
    JSON.stringify({
      issuerVerified: true,
      userSubjectPreserved: true,
      audienceDownscoped: true,
      nativeUserReadAllowed: true,
      nativeUserWriteDenied: true,
      unauthorizedAudienceDenied: true,
      scopeEscalationDenied: true,
      unauthorizedClientDenied: true,
      unauthorizedUserDenied: true,
      refreshAndLogoutVerified: true,
    }),
  );
} finally {
  try {
    if (created) await admin.realms.del({ realm });
  } finally {
    setGlobalDispatcher(previousDispatcher);
    await dispatcher.close();
  }
}
