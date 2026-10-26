import { create } from "@bufbuild/protobuf";
import Fastify from "fastify";
import { expect, it, onTestFinished, vi } from "vitest";
import { ExecutionIdentitySchema } from "../gen/agentos/execution/v1/identity_pb.js";
import { GovernanceConfigSchema } from "../gen/agentos/governance/v1/governance_pb.js";
import { registerEnvironmentApis } from "../server/platform/environment-api.js";

async function setup(write = false, tls = false, result: unknown = { native: true }) {
  const cert = await readFile(new URL("fixtures/identity/apps.crt", import.meta.url));
  const key = await readFile(new URL("fixtures/identity/tls.key", import.meta.url));
  if (tls) {
    const directory = await mkdtemp(join(tmpdir(), "agentos-rpc-tls-"));
    await mkdir(join(directory, "lab"));
    await writeFile(join(directory, "lab", "ca.crt"), cert);
    vi.stubEnv("AGENTOS_ENVIRONMENT_CA_DIR", directory);
    onTestFinished(async () => {
      vi.unstubAllEnvs();
      await rm(directory, { recursive: true, force: true });
    });
  }
  const native = Fastify({ https: tls ? { cert, key } : null });
  const received: { authorization?: string; body: unknown }[] = [];
  native.post("/example.incidents.v1.IncidentService/:method", async (request) => {
    received.push({ authorization: request.headers.authorization, body: request.body });
    return result;
  });
  const resource = await native.listen({ host: "127.0.0.1", port: 0 });
  const address = new URL(resource);
  const app = Fastify();
  onTestFinished(async () => {
    await app.close();
    await native.close();
  });
  const principal = create(ExecutionIdentitySchema, {
    subject: "idp#human-42",
    write,
    credential: { case: "accessToken", value: "current-human-token" },
  });
  const exchanges: unknown[] = [];
  registerEnvironmentApis(
    app,
    create(GovernanceConfigSchema, {
      environments: [
        {
          environment: { name: "lab" },
          resource: tls ? "https://unreachable.environment.test" : resource,
          gateway: tls
            ? {
                address: "127.0.0.1",
                port: Number(address.port),
                tlsServerName: "environment.test",
              }
            : undefined,
          apis: [
            {
              service: "example.incidents.v1.IncidentService",
              readMethods: ["ListIncidents"],
              writeMethods: ["AcknowledgeIncident"],
            },
          ],
        },
      ],
    }),
    async (environment, identity, initiator) => {
      exchanges.push({ environment, identity, initiator });
      return "human-exchanged-token";
    },
    async () => principal,
    "https://market.example",
  );
  const request = (method = "ListIncidents", headers: Record<string, string> = {}) =>
    app.inject({
      method: "POST",
      url: `/environments/lab/rpc/example.incidents.v1.IncidentService/${method}`,
      headers: { origin: "https://market.example", "content-type": "application/json", ...headers },
      payload: { id: "native-id" },
    });
  return { request, principal, received, exchanges, app };
}

it("forwards only configured unary environment methods with the current human's exchanged token", async () => {
  const f = await setup();
  const response = await f.request();
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ native: true });
  expect(f.received).toEqual([
    { authorization: "Bearer human-exchanged-token", body: { id: "native-id" } },
  ]);
  expect(f.exchanges).toMatchObject([
    {
      environment: "lab",
      identity: "catalog",
      initiator: { subject: "idp#human-42", write: false },
    },
  ]);
});

it("rejects unknown methods, cross-origin requests and writes by a read-only user before token exchange", async () => {
  const f = await setup();
  expect((await f.request("DeleteIncident")).statusCode).toBe(404);
  expect((await f.request("ListIncidents", { origin: "https://evil.example" })).statusCode).toBe(
    403,
  );
  expect((await f.request("AcknowledgeIncident")).statusCode).toBe(403);
  expect(f.exchanges).toEqual([]);
  expect(f.received).toEqual([]);
  f.principal.write = true;
  expect((await f.request("AcknowledgeIncident")).statusCode).toBe(200);
});

it("uses the configured gateway address, TLS server name and environment CA for native RPC", async () => {
  const f = await setup(false, true);
  const response = await f.request();
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ native: true });
  expect(f.received).toEqual([
    { authorization: "Bearer human-exchanged-token", body: { id: "native-id" } },
  ]);
});

it("relays embedded MCP App resources within the existing console response budget", async () => {
  const resource = {
    contents: [{ uri: "ui://example/topology", text: "a".repeat(3 * 1024 * 1024) }],
  };
  const f = await setup(false, false, { resource });
  const response = await f.request();
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ resource });
});

it("aborts environment responses that exceed the response budget", async () => {
  const f = await setup(false, false, { text: "a".repeat(17 * 1024 * 1024) });
  const response = await f.request();
  expect(response.statusCode).toBe(503);
  expect(response.json()).toMatchObject({ code: "resource_exhausted" });
});

it("rejects overlapping read and write methods at startup", () => {
  const app = Fastify();
  onTestFinished(() => app.close());
  expect(() =>
    registerEnvironmentApis(
      app,
      create(GovernanceConfigSchema, {
        environments: [
          {
            apis: [
              { service: "example.Service", readMethods: ["Modify"], writeMethods: ["Modify"] },
            ],
          },
        ],
      }),
      async () => "",
      undefined,
      "https://market.example",
    ),
  ).toThrow("disjoint");
});

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
