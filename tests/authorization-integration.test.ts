import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { Code } from "@connectrpc/connect";
import { OpenFgaClient, type TupleKey, type WriteAuthorizationModelRequest } from "@openfga/sdk";
import { afterAll, beforeAll, expect, it } from "vitest";
import { authorizer, type Permission } from "../server/authorization/policy.js";
import { until } from "./harness.js";

let serverProcess: ChildProcess;
let client: OpenFgaClient;
let requireAll: ReturnType<typeof authorizer>;
let modelId: string;
const permissions: Permission[] = [
  { user: "principal:alice", relation: "can_read", object: "resource:connection/item" },
  {
    user: "agent:workspace/reader",
    relation: "agent_can_read",
    object: "resource:connection/item",
  },
  { user: "grant:root", relation: "grant_can_read", object: "resource:connection/item" },
  { user: "principal:alice", relation: "can_execute", object: "grant:root" },
  { user: "agent:workspace/reader", relation: "assignee", object: "grant:root" },
  { user: "session:alice", relation: "session", object: "grant:root" },
];
let live: TupleKey;

beforeAll(async () => {
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("TCP listener required");
  const port = address.port;
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  serverProcess = spawn(
    ".cache/bin/openfga",
    [
      "run",
      "--datastore-engine=memory",
      `--http-addr=127.0.0.1:${port}`,
      "--grpc-addr=127.0.0.1:0",
      "--log-level=error",
      "--playground-enabled=false",
      "--metrics-enabled=false",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  serverProcess.stdout?.on("data", (chunk) => {
    output += chunk;
  });
  serverProcess.stderr?.on("data", (chunk) => {
    output += chunk;
  });
  const apiUrl = `http://127.0.0.1:${port}`;
  await until(async () => {
    if (serverProcess.exitCode !== null) throw new Error(output);
    return fetch(`${apiUrl}/healthz`, { signal: AbortSignal.timeout(300) })
      .then((r) => r.ok)
      .catch(() => false);
  }, 15_000);
  client = new OpenFgaClient({
    apiUrl,
    baseOptions: { timeout: 2_000, maxRedirects: 0 },
    retryParams: { maxRetry: 0 },
  });
  client.storeId = (await client.createStore({ name: "authorization-integration" })).id;
  const model: WriteAuthorizationModelRequest = JSON.parse(
    execFileSync(
      ".cache/bin/fga",
      ["model", "transform", "--file=authorization/model.fga", "--output-format=json"],
      { encoding: "utf8" },
    ),
  );
  modelId = (await client.writeAuthorizationModel(model)).authorization_model_id;
  requireAll = authorizer(client, modelId);
  live = {
    user: "principal:alice",
    relation: "live",
    object: "grant:root",
    condition: {
      name: "unexpired",
      context: { expires_at: new Date(Date.now() + 600_000).toISOString() },
    },
  };
  await client.write(
    {
      writes: [
        { user: "principal:alice", relation: "reader", object: "resource:connection/item" },
        {
          user: "agent:workspace/reader",
          relation: "readable_by",
          object: "resource:connection/item",
        },
        { user: "grant:root", relation: "read_grant", object: "resource:connection/item" },
        { user: "principal:alice", relation: "initiator", object: "grant:root" },
        { user: "principal:alice", relation: "root", object: "grant:root" },
        { user: "agent:workspace/reader", relation: "assignee", object: "grant:root" },
        { user: "session:alice", relation: "session", object: "grant:root" },
        live,
      ],
    },
    { authorizationModelId: modelId },
  );
}, 20_000);

afterAll(async () => {
  if (serverProcess?.exitCode === null) {
    serverProcess.kill("SIGTERM");
    await once(serverProcess, "exit");
  }
});

it("requires the principal, Agent, grant and native Session checks together", async () => {
  await expect(requireAll(permissions)).resolves.toBeUndefined();
  for (const [index, user] of [
    [0, "principal:bob"],
    [1, "agent:workspace/other"],
    [2, "grant:other"],
    [5, "session:another"],
  ] as const) {
    const checks = permissions.map((check, position) =>
      position === index ? { ...check, user } : check,
    );
    await expect(requireAll(checks)).rejects.toMatchObject({ code: Code.PermissionDenied });
  }
  await expect(requireAll([])).rejects.toMatchObject({ code: Code.PermissionDenied });
});

it("refuses an operation outside the user, Agent or grant ceiling", async () => {
  for (const relation of ["can_operate", "agent_can_operate", "grant_can_operate"]) {
    const checks = permissions.map((check) =>
      check.relation === relation.replace("operate", "read") ? { ...check, relation } : check,
    );
    await expect(requireAll(checks)).rejects.toMatchObject({ code: Code.PermissionDenied });
  }
});

it("revokes descendants immediately after the parent grant is removed", async () => {
  await client.write(
    {
      writes: [
        { user: "principal:alice", relation: "initiator", object: "grant:child" },
        { user: "grant:root", relation: "parent", object: "grant:child" },
        { ...live, object: "grant:child" },
      ],
    },
    { authorizationModelId: modelId },
  );
  const child = [{ user: "principal:alice", relation: "can_execute", object: "grant:child" }];
  await expect(requireAll(child)).resolves.toBeUndefined();
  const key = { user: live.user, relation: live.relation, object: live.object };
  await client.write({ deletes: [key] }, { authorizationModelId: modelId });
  try {
    await expect(requireAll(permissions)).rejects.toMatchObject({ code: Code.PermissionDenied });
    await expect(requireAll(child)).rejects.toMatchObject({ code: Code.PermissionDenied });
    await expect(
      requireAll([{ ...child[0], contextualTuples: [live] } as Permission]),
    ).rejects.toMatchObject({ code: Code.PermissionDenied });
  } finally {
    await client.write({ writes: [live] }, { authorizationModelId: modelId });
  }
});

it("fails closed when the policy service is unavailable", async () => {
  const offline = new OpenFgaClient({
    apiUrl: "http://127.0.0.1:1",
    storeId: client.storeId,
    retryParams: { maxRetry: 0 },
    baseOptions: { timeout: 200 },
  });
  await expect(authorizer(offline, modelId)(permissions)).rejects.toMatchObject({
    code: Code.Unavailable,
  });
});

it("pins checks to the validated model when a different model is published", async () => {
  await client.writeAuthorizationModel({
    schema_version: "1.1",
    type_definitions: [{ type: "principal" }],
  });
  await expect(requireAll(permissions)).resolves.toBeUndefined();
});
