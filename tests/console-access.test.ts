import { Code, ConnectError, createClient, createRouterTransport } from "@connectrpc/connect";
import { expect, it, vi } from "vitest";
import { Capability } from "../gen/agentos/authorization/v1/permission_pb.js";
import { ConsoleService } from "../gen/agentos/console/v1/console_service_pb.js";
import { SystemService } from "../gen/kagent/api/v1/system_pb.js";
import { userIdentity } from "../server/authorization/identity.js";
import { kagentClients } from "../server/kagent/clients.js";
import {
  credentialHeaders,
  nativeCredentials,
  nativeHeaders,
  nativeRequestHeaders,
  nativeStream,
} from "../server/kagent/context.js";
import { accessProfile, workspaceContext } from "../server/platform/access.js";
import { capabilityRole } from "../shared/permissions.js";

function setup() {
  const received: Headers[] = [];
  const native = kagentClients(
    createRouterTransport((router) =>
      router.service(SystemService, {
        getCurrentUser(_request, context) {
          received.push(new Headers(context.requestHeader));
          const token = context.requestHeader.get("authorization");
          const roles =
            token === "Bearer writer"
              ? ["writer"]
              : token === "Bearer administrator"
                ? [capabilityRole(Capability.AGENTS_MANAGE)]
                : [];
          if (!["Bearer reader", "Bearer writer", "Bearer administrator"].includes(token ?? ""))
            throw new ConnectError("Native authentication failed", Code.Unauthenticated);
          return { principalId: "oidc:canonical-principal", claims: { roles } };
        },
      }),
    ),
  );
  const send = vi.fn(() => ({}));
  const update = vi.fn(() => ({}));
  const client = createClient(
    ConsoleService,
    createRouterTransport(
      (router) =>
        router.service(ConsoleService, {
          getAccessProfile: (_request, context) => ({ profile: context.values.get(accessProfile) }),
          sendMessage: send,
          updateRole: update,
        }),
      {
        router: {
          interceptors: [
            workspaceContext("workspace", "assistant", userIdentity(native, "writer")),
          ],
        },
      },
    ),
  );
  return { client, received, send, update };
}

it("uses the native canonical principal and forwards only native credential headers", async () => {
  const env = setup();
  const header = {
    authorization: "Bearer reader",
    "x-auth-request-groups": "writer",
    "x-user-id": "mallory",
    "x-forwarded-access-token": "forged",
  };
  const { profile } = await env.client.getAccessProfile({}, { headers: header });
  expect(profile).toMatchObject({
    workspace: "workspace",
    subject: "oidc:canonical-principal",
    write: false,
    capabilities: [],
  });
  for (const key of ["x-auth-request-groups", "x-user-id", "x-forwarded-access-token"])
    expect(env.received[0]?.has(key)).toBe(false);
  await env.client.sendMessage({}, { headers: header });
  await expect(env.client.updateRole({}, { headers: header })).rejects.toMatchObject({
    code: Code.PermissionDenied,
  });
  expect(env.send).toHaveBeenCalledOnce();
  expect(env.update).not.toHaveBeenCalled();
});

it("preserves native authentication rejection including missing or forwarded-only tokens", async () => {
  const { client } = setup();
  for (const headers of [
    {},
    { authorization: "Bearer forged" },
    { "x-forwarded-access-token": "reader" },
  ] as Record<string, string>[])
    await expect(client.getAccessProfile({}, { headers })).rejects.toMatchObject({
      code: Code.Unauthenticated,
    });
});

it("keeps business management capabilities separate from target-system write permission", async () => {
  const { client, update } = setup();
  const writer = { headers: { authorization: "Bearer writer" } };
  expect((await client.getAccessProfile({}, writer)).profile).toMatchObject({
    write: true,
    capabilities: [],
  });
  await expect(client.updateRole({}, writer)).rejects.toMatchObject({
    code: Code.PermissionDenied,
  });
  const administrator = { headers: { authorization: "Bearer administrator" } };
  expect((await client.getAccessProfile({}, administrator)).profile).toMatchObject({
    write: false,
    capabilities: [Capability.AGENTS_MANAGE],
  });
  await client.updateRole({}, administrator);
  expect(update).toHaveBeenCalledOnce();
});

it("isolates concurrent deferred streams and their finalizers in native request scope", async () => {
  const observed: string[] = [];
  async function* source() {
    try {
      await new Promise((resolve) => setImmediate(resolve));
      yield nativeHeaders.getStore()?.get("authorization");
      await new Promise((resolve) => setImmediate(resolve));
      yield nativeHeaders.getStore()?.get("authorization");
    } finally {
      observed.push(nativeHeaders.getStore()?.get("authorization") ?? "missing");
    }
  }
  const a = nativeStream(
    source(),
    credentialHeaders(new Headers({ authorization: "Bearer alice", "x-user-id": "forged" })),
  )[Symbol.asyncIterator]();
  const b = nativeStream(source(), new Headers({ authorization: "Bearer bob" }))[
    Symbol.asyncIterator
  ]();
  expect((await Promise.all([a.next(), b.next()])).map((value) => value.value)).toEqual([
    "Bearer alice",
    "Bearer bob",
  ]);
  expect((await a.next()).value).toBe("Bearer alice");
  await Promise.all([a.return?.(), b.return?.()]);
  expect(observed.sort()).toEqual(["Bearer alice", "Bearer bob"]);
  expect(nativeHeaders.getStore()).toBeUndefined();
});

it("forwards request language separately from credentials and isolates concurrent calls", async () => {
  const received: Array<{ language: string | null; user: string | null }> = [];
  const client = kagentClients(
    createRouterTransport(
      (router) =>
        router.service(SystemService, {
          getCurrentUser(_request, context) {
            received.push({
              language: context.requestHeader.get("accept-language"),
              user: context.requestHeader.get("x-user-id"),
            });
            return { principalId: "reader" };
          },
        }),
      { transport: { interceptors: [nativeCredentials] } },
    ),
  );
  await Promise.all(
    ["en", "zh-CN"].map((language) =>
      nativeHeaders.run(
        nativeRequestHeaders(
          new Headers({
            authorization: "Bearer reader",
            "Accept-Language": language,
            "x-user-id": "forged",
          }),
        ),
        () => client.system.getCurrentUser({}),
      ),
    ),
  );
  expect(received.map((value) => value.language).sort()).toEqual(["en", "zh-CN"]);
  expect(received.every((value) => value.user === null)).toBe(true);
  expect(credentialHeaders(new Headers({ "Accept-Language": "en" })).has("accept-language")).toBe(
    false,
  );
  await client.system.getCurrentUser({});
  expect(received.at(-1)?.language).toBeNull();
});
