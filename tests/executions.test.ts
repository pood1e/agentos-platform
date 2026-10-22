import { clone, create } from "@bufbuild/protobuf";
import { Code } from "@connectrpc/connect";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { beforeEach, expect, it } from "vitest";
import { Capability } from "../gen/agentos/authorization/v1/permission_pb.js";
import {
  ExecutionBindingSchema,
  ExecutionIdentitySchema,
} from "../gen/agentos/execution/v1/identity_pb.js";
import { SessionSchema } from "../gen/kagent/api/v1/sessions_pb.js";
import { executions } from "../server/authorization/executions.js";
import { jwtIdentity } from "../server/authorization/oidc.js";
import type { ExecutionStore } from "../server/authorization/store.js";
import { capabilityRole } from "../shared/permissions.js";
import { memoryStore } from "./fixtures/execution-store.js";

const issuer = "https://identity.test/realms/workspace";
const keys = await generateKeyPair("RS256");
const verify = jwtIdentity(
  { issuer, audience: "platform", writerRole: "writer", origin: "https://console.test" },
  createLocalJWKSet({ keys: [await exportJWK(keys.publicKey)] }),
);
const session = (id: string, name = "assistant") =>
  create(SessionSchema, { id, creator: "native-storage", agent: { namespace: "workspace", name } });
const now = Math.floor(Date.now() / 1000);
async function user(
  subject: string,
  write: boolean,
  issued = now,
  expires = now + 600,
  capabilities: Capability[] = [],
) {
  const token = await new SignJWT({
    roles: [...(write ? ["writer"] : []), ...capabilities.map(capabilityRole)],
  })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(issuer)
    .setAudience("platform")
    .setSubject(subject)
    .setIssuedAt(issued)
    .setExpirationTime(expires)
    .sign(keys.privateKey);
  return create(ExecutionIdentitySchema, {
    subject: `${issuer}#${subject}`,
    write,
    capabilities,
    credential: { case: "accessToken", value: token },
  });
}
let store: ExecutionStore, registry: ReturnType<typeof executions>;
beforeEach(() => {
  store = memoryStore();
  registry = executions(store, verify);
});

it("lets a reader execute, binds the real subject and prevents foreign resume and grant reassignment", async () => {
  const alice = await user("alice", false),
    bob = await user("bob", true),
    own = session("own");
  await registry.bind(own, alice);
  expect(await registry.own(own, alice)).toMatchObject({
    write: false,
    binding: { subject: alice.subject },
  });
  await expect(registry.own(own, bob)).rejects.toMatchObject({ code: Code.PermissionDenied });
  await expect(registry.bind(own, bob)).rejects.toMatchObject({ code: Code.PermissionDenied });
  await expect(registry.resolve(session("own", "another-agent"))).rejects.toMatchObject({
    code: Code.PermissionDenied,
  });
  await expect(registry.resolve(session("unbound-historical"))).rejects.toMatchObject({
    code: Code.PermissionDenied,
  });
});

it("preserves the initial read ceiling after promotion and inherits it through nested delegation", async () => {
  const reader = await user("alice", false),
    promoted = await user("alice", true, now + 1);
  const root = session("root"),
    child = session("child", "engineer"),
    grandchild = session("grandchild", "worker");
  await registry.bind(root, reader);
  await registry.remember(promoted);
  await registry.bind(child, promoted, root);
  await registry.bind(grandchild, promoted, child);
  expect((await registry.resolve(grandchild)).write).toBe(false);
  await registry.delegate(root, grandchild);
  await registry.bind(session("new-root"), promoted);
  expect((await registry.resolve(session("new-root"))).write).toBe(true);
  await expect(registry.delegate(root, session("new-root"))).rejects.toMatchObject({
    code: Code.PermissionDenied,
  });
});

it("remembers downgrades across restart and rejects replaying an older writer token", async () => {
  const writer = await user("alice", true, now - 10),
    reader = await user("alice", false, now);
  await registry.bind(session("root"), writer);
  expect((await registry.resolve(session("root"))).write).toBe(true);
  await registry.remember(reader);
  registry = executions(store, verify);
  expect((await registry.remember(writer)).write).toBe(false);
  expect((await registry.resolve(session("root"))).write).toBe(false);
  await registry.remember(await user("alice", true, now));
  expect((await registry.resolve(session("root"))).write).toBe(false);
});

it("revokes every descendant including background work and never resurrects an idempotent binding", async () => {
  const writer = await user("alice", true),
    root = session("root"),
    child = session("child");
  await registry.bind(root, writer);
  await registry.bind(child, writer, root);
  await registry.revoke(root, writer);
  await registry.bind(root, writer);
  registry = executions(store, verify);
  await expect(registry.resolve(child)).rejects.toMatchObject({ code: Code.PermissionDenied });
  expect((await registry.record(child, true)).binding.parentSessionId).toBe(root.id);
});

it("rejects forged, expired and missing credentials without using a service identity", async () => {
  const expired = await user("alice", true, now - 60, now - 1);
  await registry.bind(session("expired"), expired);
  await expect(registry.resolve(session("expired"))).rejects.toMatchObject({
    code: Code.Unauthenticated,
  });
  const forged = await user("bob", true);
  if (forged.credential.case === "accessToken") forged.credential.value += "bad";
  await registry.bind(session("forged"), forged);
  await expect(registry.resolve(session("forged"))).rejects.toMatchObject({
    code: Code.Unauthenticated,
  });
  await expect(
    registry.bind(
      session("missing"),
      create(ExecutionIdentitySchema, { subject: "admin", write: true }),
    ),
  ).rejects.toMatchObject({ code: Code.PermissionDenied });
});

it("supports an explicit machine principal without OIDC and fences it from human sessions", async () => {
  const machine = create(ExecutionIdentitySchema, {
    subject: "console",
    write: true,
    credential: { case: "service", value: true },
  });
  await registry.bind(session("machine"), machine);
  expect((await executions(store).resolve(session("machine"))).write).toBe(true);
  await registry.bind(session("human"), await user("alice", true));
  await expect(registry.delegate(session("machine"), session("human"))).rejects.toMatchObject({
    code: Code.PermissionDenied,
  });
});

it("rejects cycles, missing parents and subject changes in the authoritative chain", async () => {
  const alice = await user("alice", true),
    root = session("root"),
    child = session("child");
  await registry.bind(root, alice);
  await registry.bind(child, alice, root);
  const saved = await store.binding(child.id);
  if (!saved) throw new Error("Fixture binding missing");
  const value = clone(ExecutionBindingSchema, saved.value);
  value.parentSessionId = child.id;
  await store.saveBinding(value, saved.version);
  await expect(registry.resolve(child)).rejects.toMatchObject({ code: Code.PermissionDenied });
});

it("retires shared console execution authority when OIDC is enabled", async () => {
  const shared = create(ExecutionIdentitySchema, {
    subject: "console",
    write: true,
    credential: { case: "service", value: true },
  });
  await executions(store).bind(session("open-console"), shared);
  expect((await executions(store).resolve(session("open-console"))).write).toBe(true);
  await expect(registry.resolve(session("open-console"))).rejects.toMatchObject({
    code: Code.PermissionDenied,
  });
});

it("captures platform capability ceilings through delegation without lowering the user's new roots", async () => {
  const reader = await user("alice", false),
    manager = await user("alice", false, now + 1, now + 600, [Capability.KNOWLEDGE_MANAGE]);
  const root = session("root"),
    child = session("child", "knowledge");
  await registry.bind(root, reader);
  await registry.remember(manager);
  await registry.bind(child, manager, root);
  expect((await registry.resolve(child)).capabilities).toEqual([]);
  await registry.bind(session("fresh"), manager);
  expect((await registry.resolve(session("fresh"))).capabilities).toEqual([
    Capability.KNOWLEDGE_MANAGE,
  ]);
  expect((await store.identity(manager.subject))?.value.capabilities).toEqual([
    Capability.KNOWLEDGE_MANAGE,
  ]);
});

it("persists capability revocation and intersects tokens issued in the same second", async () => {
  const first = await user("alice", false, now - 1, now + 600, [Capability.KNOWLEDGE_MANAGE]),
    removed = await user("alice", false, now, now + 600, [Capability.SKILLS_MANAGE]),
    sameSecond = await user("alice", false, now, now + 600, [
      Capability.KNOWLEDGE_MANAGE,
      Capability.SKILLS_MANAGE,
    ]);
  await registry.bind(session("root"), first);
  expect((await registry.resolve(session("root"))).capabilities).toEqual([
    Capability.KNOWLEDGE_MANAGE,
  ]);
  await registry.remember(removed);
  expect((await registry.resolve(session("root"))).capabilities).toEqual([]);
  registry = executions(store, verify);
  expect((await registry.remember(first)).capabilities).toEqual([]);
  expect((await registry.remember(sameSecond)).capabilities).toEqual([Capability.SKILLS_MANAGE]);
  await registry.bind(session("fresh"), sameSecond);
  expect((await registry.resolve(session("fresh"))).capabilities).toEqual([
    Capability.SKILLS_MANAGE,
  ]);
});
