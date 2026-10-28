import { createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:https";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { fromJsonString } from "@bufbuild/protobuf";
import type { AuthenticationV1Api } from "@kubernetes/client-node";
import { importPKCS8, SignJWT } from "jose";
import { afterAll, expect, it, vi } from "vitest";
import { WorkloadAuthenticationSchema } from "../gen/agentos/authorization/v1/workload_pb.js";
import { workloadIdentity } from "../server/authorization/workloads.js";

const roots = getCACertificates();
setDefaultCACertificates([...roots, readFileSync("tests/fixtures/identity/tls.crt", "utf8")]);
afterAll(() => setDefaultCACertificates(roots));

const key = readFileSync("tests/fixtures/identity/tls.key", "utf8");
const signing = await importPKCS8(key, "RS256");
const jwks = {
  keys: [{ ...createPublicKey(key).export({ format: "jwk" }), alg: "RS256", use: "sig" }],
};
const config = () =>
  fromJsonString(
    WorkloadAuthenticationSchema,
    readFileSync("tests/fixtures/identity/workloads.json", "utf8"),
  );
async function token(issuer: string, audience: string, subject: string, claims = {}) {
  return `Bearer ${await new SignJWT(claims).setProtectedHeader({ alg: "RS256" }).setIssuer(issuer).setAudience(audience).setSubject(subject).setIssuedAt().setExpirationTime("5m").sign(signing)}`;
}

it("delegates projected credentials to TokenReview with exact audiences and subjects on every request", async () => {
  const trust = config();
  const review = vi.fn<AuthenticationV1Api["createTokenReview"]>(async ({ body }) => {
    const controller = body.spec?.token === "controller";
    const valid = controller || body.spec?.token === "platform";
    const audience = controller ? "agentos-mcp-discovery" : trust.modelAudience;
    return {
      spec: body.spec,
      status: {
        authenticated: valid,
        audiences: body.spec?.audiences?.includes(audience) ? [audience] : [],
        user: { username: controller ? trust.controllerSubject : trust.platformSubjects[1] },
      },
    };
  });
  const identity = workloadIdentity(trust, { createTokenReview: review });
  const controller = { authorization: "Bearer controller" };
  const platform = { authorization: "Bearer platform" };
  await identity.controller(controller, "tools/list");
  await identity.model(platform);
  await expect(identity.controller(controller, "tools/call")).rejects.toThrow();
  await expect(identity.model(controller)).rejects.toThrow();
  await expect(identity.controller(platform, "tools/list")).rejects.toThrow();
  for (const headers of [{}, { authorization: "Bearer forged" }])
    await expect(identity.controller(headers, "tools/list")).rejects.toThrow();
  for (const status of [
    undefined,
    { authenticated: false },
    { authenticated: true, audiences: [] },
    { authenticated: true, audiences: ["other"] },
    {
      authenticated: true,
      audiences: ["agentos-mcp-discovery"],
      user: { username: "system:serviceaccount:other:kagent-controller" },
    },
  ]) {
    review.mockResolvedValueOnce({ spec: { token: "controller" }, status });
    await expect(identity.controller(controller, "tools/list")).rejects.toThrow();
  }
  await identity.controller(controller, "tools/list");
  review.mockResolvedValueOnce({
    spec: { token: "controller" },
    status: { authenticated: false, error: "Bound Pod was deleted" },
  });
  await expect(identity.controller(controller, "tools/list")).rejects.toThrow();
  review.mockRejectedValueOnce(new Error("Kubernetes unavailable"));
  await expect(identity.model(platform)).rejects.toThrow("Kubernetes unavailable");
});

it("validates the registered environment issuer, audience, client and service-account subject", async () => {
  const server = createServer(
    { key, cert: readFileSync("tests/fixtures/identity/tls.crt") },
    (request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify(request.url === "/jwks" ? jwks : { issuer, jwks_uri: `${issuer}/jwks` }),
      );
    },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Identity server unavailable");
  const issuer = `https://127.0.0.1:${address.port}`;
  const trust = config();
  trust.executionSources.push({
    $typeName: "agentos.authorization.v1.ExecutionSource",
    issuer,
    audience: "agentos-executions",
    clientId: "execution-client",
    subject: "service-account-123",
    agents: [
      { $typeName: "kagent.api.v1.ResourceReference", namespace: "agentos", name: "inspection" },
    ],
    write: false,
    capabilities: [],
  });
  const source = trust.executionSources[0];
  if (!source) throw new Error("Execution source missing");
  trust.executionSources.unshift({ ...source, audience: "another-execution-api", write: true });
  const identity = workloadIdentity(trust, {
    createTokenReview: vi.fn<AuthenticationV1Api["createTokenReview"]>(),
  });
  try {
    const authorized = await token(issuer, "agentos-executions", "service-account-123", {
      azp: "execution-client",
    });
    expect((await identity.execution({ authorization: authorized })).clientId).toBe(
      "execution-client",
    );
    expect((await identity.execution({ authorization: authorized })).write).toBe(false);
    for (const [audience, subject, azp] of [
      ["other-audience", "service-account-123", "execution-client"],
      ["agentos-executions", "human-user", "execution-client"],
      ["agentos-executions", "service-account-123", "other-client"],
    ])
      await expect(
        identity.execution({ authorization: await token(issuer, audience, subject, { azp }) }),
      ).rejects.toThrow();
    await expect(
      identity.execution({ authorization: authorized.slice(0, -10) + "0".repeat(10) }),
    ).rejects.toThrow();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
