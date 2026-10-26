import { create } from "@bufbuild/protobuf";
import Fastify from "fastify";
import { expect, it, onTestFinished } from "vitest";
import { ExecutionIdentitySchema } from "../gen/agentos/execution/v1/identity_pb.js";
import { GovernanceConfigSchema } from "../gen/agentos/governance/v1/governance_pb.js";
import { registerEnvironmentApis } from "../server/platform/environment-api.js";

async function setup(write = false) {
  const native = Fastify();
  const received: { authorization?: string; body: unknown }[] = [];
  native.post("/example.incidents.v1.IncidentService/:method", async (request) => {
    received.push({ authorization: request.headers.authorization, body: request.body });
    return { native: true };
  });
  const resource = await native.listen({ host: "127.0.0.1", port: 0 });
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
          resource,
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
