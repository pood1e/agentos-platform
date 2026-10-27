import { randomUUID } from "node:crypto";
import { clone, create } from "@bufbuild/protobuf";
import { Code } from "@connectrpc/connect";
import { afterEach, expect, it } from "vitest";
import { MessageSchema, Role, TaskSchema, TaskState } from "../gen/a2a_pb.js";
import { SendMessageRequestSchema } from "../gen/agentos/console/v1/console_service_pb.js";
import { ExecutionIdentitySchema } from "../gen/agentos/execution/v1/identity_pb.js";
import { SessionSchema } from "../gen/kagent/api/v1/sessions_pb.js";
import { executions } from "../server/authorization/executions.js";
import { scheduledIdentity } from "../server/automation/identity.js";
import { viewer, visibleGraph } from "../server/console/history.js";
import { messageCommands } from "../server/console/messages.js";
import { allCapabilities } from "../shared/permissions.js";
import { memoryStore } from "./fixtures/execution-store.js";
import { environment } from "./harness.js";

const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
});
async function setup() {
  const env = await environment([]);
  stops.push(() => env.close());
  const schedule = (await env.clients.schedules.listScheduledRuns({})).scheduledRuns[0];
  const execution = (
    await env.clients.schedules.triggerScheduledRun({
      scheduledRunId: schedule.id,
      requestId: randomUUID(),
    })
  ).execution;
  if (!execution) throw new Error("Missing execution");
  const session = env.fake.sessions.get(execution.sessionId);
  if (!session) throw new Error("Missing scheduled session");
  const registry = executions(
    env.store,
    undefined,
    scheduledIdentity(env.clients, "agentos", "agentos"),
  );
  return { ...env, registry, schedule, execution, session };
}

it("admits the first scheduled task before persistence using native session attestation and grants read-only delegation", async () => {
  const { fake, registry, session, execution, schedule } = await setup();
  fake.tasks.delete(execution.taskId);
  await expect(registry.record(session)).rejects.toMatchObject({ code: Code.PermissionDenied });
  const admitted = await registry.record(session, false, [`scheduled-run/${execution.id}`]);
  expect(admitted.binding.subject).toBe(`service:schedule:agentos:${schedule.id}`);
  const context = await registry.resolve(session);
  expect(context).toMatchObject({
    write: false,
    capabilities: [],
    identity: { write: false, credential: { case: "service", value: true } },
  });
  const child = create(SessionSchema, {
    id: randomUUID(),
    agent: { namespace: "agentos", name: "remediation" },
  });
  await registry.bind(child, context.identity, session);
  expect((await registry.resolve(child)).write).toBe(false);
});

it("rejects forged message IDs, foreign sessions, wrong creators and Agent substitution", async () => {
  const { clients, fake, registry, session, execution } = await setup();
  const impersonator = fake.createSession(
    { namespace: "agentos", name: "inspection" },
    randomUUID(),
    "Forged",
  );
  await expect(
    registry.record(impersonator, false, [`scheduled-run/${execution.id}`]),
  ).rejects.toMatchObject({ code: Code.PermissionDenied });
  await expect(
    registry.record(impersonator, false, [`scheduled-run/${randomUUID()}`]),
  ).rejects.toMatchObject({ code: Code.PermissionDenied });
  const changed = clone(SessionSchema, session);
  if (changed.agent) changed.agent.name = "remediation";
  await expect(
    registry.record(changed, false, [`scheduled-run/${execution.id}`]),
  ).rejects.toMatchObject({ code: Code.PermissionDenied });
  const wrongCreator = executions(
    memoryStore(),
    undefined,
    scheduledIdentity(clients, "agentos", "someone-else"),
  );
  await expect(
    wrongCreator.record(session, false, [`scheduled-run/${execution.id}`]),
  ).rejects.toMatchObject({ code: Code.PermissionDenied });
  const foreign = executions(
    memoryStore(),
    undefined,
    scheduledIdentity(clients, "another-workspace", "agentos"),
  );
  await expect(
    foreign.record(session, false, [`scheduled-run/${execution.id}`]),
  ).rejects.toMatchObject({ code: Code.PermissionDenied });
});

it("keeps personal bindings immutable even when a message claims a scheduled origin", async () => {
  const { registry, session, execution, reconcile, projection } = await setup();
  const owner = create(ExecutionIdentitySchema, {
    subject: "user:alice",
    write: false,
    credential: { case: "service", value: true },
  });
  await registry.bind(session, owner);
  expect(
    (await registry.record(session, false, [`scheduled-run/${execution.id}`])).binding.subject,
  ).toBe(owner.subject);
  await reconcile.refresh();
  const bob = create(ExecutionIdentitySchema, { subject: "user:bob" });
  expect(await visibleGraph(projection, viewer(bob), { contextId: session.id })).toBeUndefined();
});

it("keeps chat creation retries from claiming a reserved scheduled session", async () => {
  const { fake, clients, projection, reconcile, registry, session, execution } = await setup();
  fake.tasks.delete(execution.taskId);
  await reconcile.refresh();
  const identity = create(ExecutionIdentitySchema, {
    subject: "user:alice",
    write: true,
    credential: { case: "service", value: true },
  });
  const messageId = `scheduled-run/${execution.id}`;
  const response = await messageCommands(projection, clients, "agentos", registry).send(
    create(SendMessageRequestSchema, {
      agent: session.agent,
      messageId,
      text: "Read current health",
    }),
    identity,
  );
  expect(response.contextId).not.toBe(session.id);
  expect((await registry.record(session, false, [messageId])).binding.subject).toContain(
    "service:schedule:",
  );
  expect((await registry.resolve(session)).write).toBe(false);
});

it("shares native system executions with every administrator while preserving personal history isolation", async () => {
  const { fake, projection, reconcile, registry, session, execution } = await setup();
  await registry.record(session, false, [`scheduled-run/${execution.id}`]);
  const privateSession = fake.createSession(
    { namespace: "agentos", name: "inspection" },
    randomUUID(),
    "Alice private",
  );
  const alice = create(ExecutionIdentitySchema, {
    subject: "user:alice",
    credential: { case: "service", value: true },
  });
  await registry.bind(privateSession, alice);
  fake.tasks.set(
    "personal-task",
    create(TaskSchema, {
      id: "personal-task",
      contextId: privateSession.id,
      status: { state: TaskState.COMPLETED },
      history: [
        create(MessageSchema, {
          role: Role.USER,
          messageId: "personal",
          parts: [{ content: { case: "text", value: "Private" } }],
        }),
      ],
    }),
  );
  await reconcile.refresh();
  const page = { query: "", pageToken: "", pageSize: 100 };
  const roots = async (identity: typeof alice, systemOnly = false) =>
    (await projection.operations(viewer(identity, systemOnly), page)).tasks.map((task) => [
      task.contextId,
      task.id,
    ]);
  const reader = create(ExecutionIdentitySchema, {
    subject: "user:bob",
    credential: { case: "service", value: true },
  });
  expect((await roots(reader)).flat()).not.toContain(session.id);
  expect((await roots(reader)).flat()).not.toContain("personal-task");
  for (const capability of allCapabilities) {
    reader.capabilities = [capability];
    expect((await roots(reader)).flat()).toContain(session.id);
    expect((await roots(reader)).flat()).not.toContain("personal-task");
  }
  alice.capabilities = allCapabilities;
  expect((await roots(alice)).flat()).toContain("personal-task");
  expect((await roots(alice, true)).flat()).toContain(session.id);
  expect((await roots(alice, true)).flat()).not.toContain("personal-task");
  expect((await registry.resolve(session)).write).toBe(false);
});
