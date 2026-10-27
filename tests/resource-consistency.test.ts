import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  ConnectionKind,
  ConnectionSchema,
  SaveConnectionRequestSchema,
} from "../gen/agentos/management/v1/management_pb.js";
import { connectionCommands } from "../server/management/connections.js";
import { object } from "../server/read-model/decode/messages.js";
import { managementEnvironment } from "./management-harness.js";

let env: Awaited<ReturnType<typeof managementEnvironment>>;
beforeEach(async () => {
  env = await managementEnvironment();
});
afterEach(async () => {
  await env.close();
});
const draft = () =>
  create(ConnectionSchema, {
    kind: ConnectionKind.MODEL,
    resource: {
      apiVersion: "agentgateway.dev/v1alpha1",
      kind: "AgentgatewayModel",
      value: {
        apiVersion: "agentgateway.dev/v1alpha1",
        kind: "AgentgatewayModel",
        metadata: { name: "versioned-model" },
        spec: {
          provider: "OpenAI",
          baseURL: "https://provider.test/v1",
          match: { model: "old-model" },
        },
      },
    },
  });

it("commits one parent and leaves derived resources to reconciliation", async () => {
  const commands = connectionCommands(env.store, env.clients, env.dependencies.gateway);
  const save = vi.spyOn(env.store, "save");
  const validate = vi.spyOn(env.store, "validate");
  await commands.save(
    create(SaveConnectionRequestSchema, {
      create: true,
      connection: draft(),
      credential: "secret",
    }),
  );
  expect(save.mock.calls.map(([kind]) => kind)).toEqual(["models"]);
  expect(validate).not.toHaveBeenCalled();
  await expect(env.store.get("modelConfigs", "versioned-model")).rejects.toMatchObject({
    code: Code.NotFound,
  });
});

it("preserves a committed parent when its acknowledgement is lost", async () => {
  const commands = connectionCommands(env.store, env.clients, env.dependencies.gateway);
  const write = env.store.save;
  const save = vi.spyOn(env.store, "save").mockImplementationOnce(async (kind, ...args) => {
    await write(kind, ...args);
    throw new ConnectError("Response lost", Code.Unavailable);
  });
  await expect(
    commands.save(create(SaveConnectionRequestSchema, { create: true, connection: draft() })),
  ).rejects.toMatchObject({ code: Code.Unavailable });
  const current = await env.store.get("models", "versioned-model");
  expect(object(object(current.spec).match).model).toBe("old-model");
  save.mockRestore();
  const retry = draft();
  if (!retry.resource) throw new Error("missing connection resource");
  retry.resource.value = current;
  await expect(
    commands.save(create(SaveConnectionRequestSchema, { connection: retry })),
  ).resolves.toHaveProperty("connection");
});

it("rejects invalid parent input before writing", async () => {
  const commands = connectionCommands(env.store, env.clients, env.dependencies.gateway);
  const write = vi.spyOn(env.store, "save");
  const invalid = draft();
  object(object(invalid.resource?.value?.spec).match).model = "wildcard-*";
  await expect(
    commands.save(create(SaveConnectionRequestSchema, { create: true, connection: invalid })),
  ).rejects.toMatchObject({ code: Code.InvalidArgument });
  expect(write).not.toHaveBeenCalled();
});

it("preserves concurrent edits through native resourceVersion", async () => {
  const commands = connectionCommands(env.store, env.clients, env.dependencies.gateway);
  const { connection: initial } = await commands.save(
    create(SaveConnectionRequestSchema, { create: true, connection: draft() }),
  );
  const current = await env.store.get("models", "versioned-model");
  await env.store.save(
    "models",
    { ...current, spec: { ...object(current.spec), baseURL: "https://concurrent.test/v1" } },
    false,
  );
  await expect(
    commands.save(create(SaveConnectionRequestSchema, { connection: initial })),
  ).rejects.toMatchObject({ code: Code.Aborted });
  expect(object((await env.store.get("models", "versioned-model")).spec).baseURL).toBe(
    "https://concurrent.test/v1",
  );
});
