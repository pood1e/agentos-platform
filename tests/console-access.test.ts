import { createClient, createRouterTransport } from "@connectrpc/connect";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { beforeAll, expect, it, vi } from "vitest";
import { Capability } from "../gen/agentos/authorization/v1/permission_pb.js";
import { ConsoleService } from "../gen/agentos/console/v1/console_service_pb.js";
import { jwtIdentity } from "../server/authorization/oidc.js";
import { accessProfile, workspaceContext } from "../server/platform/access.js";
import { capabilityRole } from "../shared/permissions.js";

const issuer = "https://identity.example.test/realms/site";
const keys = await generateKeyPair("RS256");
const other = await generateKeyPair("RS256");
const send = vi.fn(() => ({}));
const update = vi.fn(() => ({}));
let client: ReturnType<typeof createClient<typeof ConsoleService>>;

beforeAll(async () => {
  const identity = jwtIdentity(
    { issuer, audience: "platform", writerRole: "writer" },
    createLocalJWKSet({ keys: [await exportJWK(keys.publicKey)] }),
  );
  client = createClient(
    ConsoleService,
    createRouterTransport(
      (router) =>
        router.service(ConsoleService, {
          getAccessProfile: (_request, context) => ({ profile: context.values.get(accessProfile) }),
          sendMessage: send,
          updateRole: update,
        }),
      { router: { interceptors: [workspaceContext("workspace", "assistant", identity)] } },
    ),
  );
});

async function headers(roles: string[] = [], audience = "platform", signingKey = keys.privateKey) {
  const token = await new SignJWT({ roles })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(issuer)
    .setSubject("user-42")
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime("2m")
    .sign(signingKey);
  return new Headers({ authorization: `Bearer ${token}` });
}

it("rejects anonymous, forged and wrong-audience identities", async () => {
  for (const value of [
    new Headers(),
    await headers(["writer"], "console"),
    await headers([], "other"),
    await headers([], "platform", other.privateKey),
  ])
    await expect(client.getAccessProfile({}, { headers: value })).rejects.toMatchObject({
      code: 16,
    });
});

it("lets readers start executions while denying configuration writes and forged group headers", async () => {
  const value = await headers();
  value.set("x-auth-request-groups", "writer");
  expect((await client.getAccessProfile({}, { headers: value })).profile).toMatchObject({
    workspace: "workspace",
    subject: `${issuer}#user-42`,
    write: false,
    capabilities: [],
  });
  await client.sendMessage({}, { headers: value });
  await expect(client.updateRole({}, { headers: value })).rejects.toMatchObject({ code: 7 });
  expect(send).toHaveBeenCalled();
  expect(update).not.toHaveBeenCalled();
});

it("allows the signed writer role without granting configuration capabilities", async () => {
  const value = await headers(["writer"]);
  expect((await client.getAccessProfile({}, { headers: value })).profile?.write).toBe(true);
  await client.sendMessage({}, { headers: value });
  await expect(client.updateRole({}, { headers: value })).rejects.toMatchObject({ code: 7 });
});

it("grants Agent administration independently of target-system write permissions", async () => {
  const value = await headers([capabilityRole(Capability.AGENTS_MANAGE)]);
  expect((await client.getAccessProfile({}, { headers: value })).profile).toMatchObject({
    write: false,
    capabilities: [Capability.AGENTS_MANAGE],
  });
  await client.updateRole({}, { headers: value });
});

it("ignores forwarded proxy tokens without a bearer header", async () => {
  const value = await headers(["writer"]);
  value.set("x-forwarded-access-token", value.get("authorization")?.slice(7) ?? "");
  value.delete("authorization");
  await expect(client.getAccessProfile({}, { headers: value })).rejects.toMatchObject({
    code: 16,
  });
});
