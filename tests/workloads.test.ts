import { createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:https";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { fromJsonString } from "@bufbuild/protobuf";
import { importPKCS8, SignJWT } from "jose";
import { afterAll, expect, it } from "vitest";
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

it("binds Kubernetes discovery and model tokens to distinct subjects, audiences and methods", async () => {
  const trust = config(),
    identity = workloadIdentity(trust);
  const controller = {
    authorization: await token(
      trust.kubernetesIssuer,
      "agentos-mcp-discovery",
      trust.controllerSubject,
    ),
  };
  const platform = {
    authorization: await token(trust.kubernetesIssuer, trust.modelAudience, trust.platformSubject),
  };
  await identity.controller(controller, "tools/list");
  await identity.model(platform);
  await expect(identity.controller(controller, "tools/call")).rejects.toThrow();
  await expect(identity.model(controller)).rejects.toThrow();
  await expect(identity.controller(platform, "tools/list")).rejects.toThrow();
  for (const headers of [
    {},
    { authorization: "Bearer forged" },
    {
      authorization: await token(
        "https://other.test",
        "agentos-mcp-discovery",
        trust.controllerSubject,
      ),
    },
    {
      authorization: await token(
        trust.kubernetesIssuer,
        "agentos-mcp-discovery",
        "system:serviceaccount:other:kagent-controller",
      ),
    },
  ])
    await expect(identity.controller(headers, "tools/list")).rejects.toThrow();
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
  trust.automationSources.push({
    $typeName: "agentos.authorization.v1.AutomationSource",
    environment: "production",
    issuer,
    audience: "agentos-automation",
    clientId: "case-worker",
    subject: "service-account-123",
  });
  const identity = workloadIdentity(trust);
  try {
    const authorized = await token(issuer, "agentos-automation", "service-account-123", {
      azp: "case-worker",
    });
    expect((await identity.automation({ authorization: authorized })).environment).toBe(
      "production",
    );
    for (const [audience, subject, azp] of [
      ["other-audience", "service-account-123", "case-worker"],
      ["agentos-automation", "human-user", "case-worker"],
      ["agentos-automation", "service-account-123", "other-client"],
    ])
      await expect(
        identity.automation({ authorization: await token(issuer, audience, subject, { azp }) }),
      ).rejects.toThrow();
    await expect(
      identity.automation({ authorization: authorized.slice(0, -10) + "0".repeat(10) }),
    ).rejects.toThrow();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
