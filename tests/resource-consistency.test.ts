import { clone, create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  ConnectionKind,
  ConnectionSchema,
  SaveConnectionRequestSchema,
} from "../gen/agentos/management/v1/management_pb.js";
import { connectionCommands } from "../server/management/connections.js";
import { object, text } from "../server/read-model/decode/messages.js";
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

it("restores the gateway and its previous credential when updating the consumer fails", async () => {
  const commands = connectionCommands(env.store, env.clients, env.dependencies.gateway);
  const initial = await commands.save(
    create(SaveConnectionRequestSchema, {
      create: true,
      connection: draft(),
      credential: "old-secret",
    }),
  );
  if (!initial.connection) throw new Error("Missing connection");
  const updated = clone(ConnectionSchema, initial.connection);
  object(object(updated.resource?.value?.spec).match).model = "new-model";
  const write = env.store.save;
  vi.spyOn(env.store, "save").mockImplementation(async (kind, ...args) => {
    if (kind === "modelConfigs")
      throw new ConnectError("Injected consumer failure", Code.Unavailable);
    return write(kind, ...args);
  });
  await expect(
    commands.save(
      create(SaveConnectionRequestSchema, { connection: updated, credential: "new-secret" }),
    ),
  ).rejects.toMatchObject({ code: Code.Aborted, rawMessage: "management.partialSave" });
  expect(object(object((await env.store.get("models", "versioned-model")).spec).match).model).toBe(
    "old-model",
  );
  expect(object((await env.store.get("modelConfigs", "versioned-model")).spec).model).toBe(
    "old-model",
  );
  const secret = env.fake.resources.get("secrets", "agentos-model-versioned-model");
  expect(Buffer.from(text(object(secret.data).Authorization), "base64").toString()).toBe(
    "old-secret",
  );
});

it("reports an uncertain result when Kubernetes commits a write but its acknowledgement is lost", async () => {
  const commands = connectionCommands(env.store, env.clients, env.dependencies.gateway);
  const write = env.store.save;
  vi.spyOn(env.store, "save").mockImplementation(async (kind, ...args) => {
    const saved = await write(kind, ...args);
    if (kind === "modelConfigs") throw new ConnectError("Response lost", Code.Unavailable);
    return saved;
  });
  await expect(
    commands.save(create(SaveConnectionRequestSchema, { create: true, connection: draft() })),
  ).rejects.toMatchObject({ code: Code.Aborted, rawMessage: "management.partialSave" });
  await expect(env.store.get("models", "versioned-model")).rejects.toMatchObject({
    code: Code.NotFound,
  });
});

it("validates all resources before modifying the connection", async () => {
  const commands = connectionCommands(env.store, env.clients, env.dependencies.gateway);
  const write = vi.spyOn(env.store, "save");
  const validate = env.store.validate;
  vi.spyOn(env.store, "validate").mockImplementation(async (kind, ...args) => {
    if (kind === "modelConfigs")
      throw new ConnectError("Invalid native model", Code.InvalidArgument);
    return validate(kind, ...args);
  });
  await expect(
    commands.save(create(SaveConnectionRequestSchema, { create: true, connection: draft() })),
  ).rejects.toMatchObject({ code: Code.InvalidArgument });
  expect(write).not.toHaveBeenCalled();
  await expect(env.store.get("models", "versioned-model")).rejects.toMatchObject({
    code: Code.NotFound,
  });
});

it("preserves a concurrent edit and explicitly reports an incomplete restoration", async () => {
  const commands = connectionCommands(env.store, env.clients, env.dependencies.gateway);
  const initial = await commands.save(
    create(SaveConnectionRequestSchema, { create: true, connection: draft() }),
  );
  const write = env.store.save;
  vi.spyOn(env.store, "save").mockImplementation(async (kind, ...args) => {
    if (kind === "modelConfigs") {
      const current = await env.store.get("models", "versioned-model");
      await write(
        "models",
        { ...current, spec: { ...object(current.spec), baseURL: "https://concurrent.test/v1" } },
        false,
      );
      throw new ConnectError("Consumer unavailable", Code.Unavailable);
    }
    return write(kind, ...args);
  });
  await expect(
    commands.save(create(SaveConnectionRequestSchema, { connection: initial.connection })),
  ).rejects.toMatchObject({ rawMessage: "management.partialSave" });
  expect(object((await env.store.get("models", "versioned-model")).spec).baseURL).toBe(
    "https://concurrent.test/v1",
  );
});
