import { once } from "node:events";
import { createServer } from "node:http";
import { create } from "@bufbuild/protobuf";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { ExecutionIdentitySchema } from "../gen/agentos/execution/v1/identity_pb.js";
import { GovernanceConfigSchema } from "../gen/agentos/governance/v1/governance_pb.js";
import { environmentTokens } from "../server/authorization/environment-tokens.js";

const origin = "https://identity.example.test";
const resource = "https://environment.example.test/mcp";
const keys = await generateKeyPair("RS256");
const jwk = { ...(await exportJWK(keys.publicKey)), kid: "test", alg: "RS256" };
const issued: URLSearchParams[] = [];
let mismatch = "";
let fail = false;
const server = createServer(async (request, response) => {
  const path = request.url ?? "";
  response.setHeader("content-type", "application/json");
  if (path.endsWith("openid-configuration")) {
    response.end(
      JSON.stringify({
        issuer: `${origin}/realm`,
        token_endpoint: `${origin}/token`,
        jwks_uri: `${origin}/keys`,
      }),
    );
    return;
  }
  if (path === "/keys") {
    response.end(JSON.stringify({ keys: [jwk] }));
    return;
  }
  let body = "";
  for await (const chunk of request) body += chunk;
  const form = new URLSearchParams(body);
  issued.push(form);
  if (fail) {
    response.writeHead(503).end(JSON.stringify({ error: "temporarily_unavailable" }));
    return;
  }
  const id = form.get("client_id") ?? "";
  const subject = form.get("subject_token")?.replace("-source", "") ?? `service-${id}`;
  const token = await new SignJWT({ azp: mismatch === "identity" ? "agentos-other" : id })
    .setProtectedHeader({ alg: "RS256", kid: "test" })
    .setIssuer(`${origin}/realm`)
    .setAudience(mismatch === "audience" ? "another-resource" : resource)
    .setSubject(mismatch === "subject" ? "other-user" : subject)
    .setExpirationTime("120s")
    .setJti(String(issued.length))
    .sign(keys.privateKey);
  response.end(JSON.stringify({ access_token: token, token_type: "Bearer", expires_in: 120 }));
});

beforeAll(async () => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test issuer unavailable");
  const local = `http://127.0.0.1:${address.port}`;
  const fetch = globalThis.fetch;
  vi.stubGlobal("fetch", (url: string | URL | Request, options?: RequestInit) => {
    const value = url instanceof Request ? url.url : String(url);
    return fetch(value.replace(origin, local), options);
  });
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});
beforeEach(() => {
  mismatch = "";
  fail = false;
  issued.length = 0;
});
const credentials = vi.fn(async (_environment: string, identity: string) => ({
  clientId: `agentos-${identity}`,
  clientSecret: `secret-${identity}`,
}));
function provider(exchange = true) {
  return environmentTokens(
    create(GovernanceConfigSchema, {
      environments: ["one", "two"].map((name) => ({
        environment: { name },
        issuer: `${origin}/realm`,
        resource,
      })),
    }),
    credentials,
    exchange,
  );
}
const user = (subject: string) =>
  create(ExecutionIdentitySchema, {
    subject: `${origin}/realm#${subject}`,
    credential: { case: "accessToken", value: `${subject}-source` },
  });

it("uses RFC 8693 for users and client credentials for native services and discovery", async () => {
  const token = provider();
  await token("one", "diagnosis", user("alice"));
  await token(
    "one",
    "diagnosis",
    create(ExecutionIdentitySchema, {
      subject: "service:scheduled",
      credential: { case: "service", value: true },
    }),
  );
  await token("one", "catalog");
  expect(issued.map((form) => form.get("client_id"))).toEqual([
    "agentos-diagnosis",
    "agentos-diagnosis",
    "agentos-catalog",
  ]);
  expect(issued[0].get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:token-exchange");
  expect(issued[0].get("subject_token")).toBe("alice-source");
  expect(issued[0].get("audience")).toBe(resource);
  expect(issued.slice(1).every((form) => form.get("grant_type") === "client_credentials")).toBe(
    true,
  );
});

it("bridges users with service credentials when environments do not trust the identity source", async () => {
  await provider(false)("one", "diagnosis", user("alice"));
  expect(issued.map((form) => form.get("grant_type"))).toEqual(["client_credentials"]);
  expect(issued[0].get("subject_token")).toBeNull();
});

it("coalesces concurrent grants and isolates users, identities and environments", async () => {
  const token = provider();
  const values = await Promise.all(
    Array.from({ length: 8 }, () => token("one", "diagnosis", user("alice"))),
  );
  expect(new Set(values).size).toBe(1);
  expect(issued).toHaveLength(1);
  await token("one", "diagnosis", user("bob"));
  await token("one", "remediation", user("alice"));
  await token("two", "diagnosis", user("alice"));
  expect(issued).toHaveLength(4);
});

it("refreshes before expiry and retries a failed grant without retaining a rejected promise", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const token = provider();
    const first = await token("one", "catalog");
    vi.setSystemTime(Date.now() + 110_000);
    expect(await token("one", "catalog")).not.toBe(first);
    fail = true;
    await expect(token("two", "catalog")).rejects.toThrow();
    fail = false;
    await expect(token("two", "catalog")).resolves.toBeTypeOf("string");
  } finally {
    vi.useRealTimers();
  }
});

it.each(["identity", "audience", "subject"])("rejects a token with the wrong %s", async (claim) => {
  mismatch = claim;
  await expect(provider()("one", "diagnosis", user("alice"))).rejects.toThrow();
});
