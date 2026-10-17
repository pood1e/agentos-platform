import { create } from "@bufbuild/protobuf";
import { Code, createClient, createRouterTransport } from "@connectrpc/connect";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { expect, it, vi } from "vitest";
import { AuthorizationConfigSchema } from "../gen/agentos/console/v1/access_pb.js";
import { ConsoleService } from "../gen/agentos/console/v1/console_service_pb.js";
import {
  accessProfile,
  authorizationConfig,
  humanAuthorization,
} from "../server/platform/authorization.js";

it("verifies OIDC identity and checks workspace operation and administration independently", async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const config = create(AuthorizationConfigSchema, {
    issuer: "https://id.example.test",
    audience: "agentos",
    jwksUrl: "https://id.example.test/jwks",
    viewerGroups: ["readers"],
    operatorGroups: ["operators"],
    administratorGroups: ["administrators"],
  });
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
            humanAuthorization(
              "workspace",
              config,
              createLocalJWKSet({ keys: [await exportJWK(publicKey)] }),
            ),
          ],
        },
      },
    ),
  );
  const token = (groups: string[], audience = "agentos", expires = "5m") =>
    new SignJWT({ groups })
      .setProtectedHeader({ alg: "RS256" })
      .setSubject("operator-1")
      .setIssuer(config.issuer)
      .setAudience(audience)
      .setIssuedAt()
      .setExpirationTime(expires)
      .sign(privateKey);
  const options = async (groups: string[], audience?: string, expires?: string) => ({
    headers: { authorization: `Bearer ${await token(groups, audience, expires)}` },
  });
  await expect(client.getAccessProfile({})).rejects.toMatchObject({ code: Code.Unauthenticated });
  await expect(
    client.getAccessProfile({}, { headers: { "x-auth-request-user": "admin" } }),
  ).rejects.toMatchObject({ code: Code.Unauthenticated });
  await expect(
    client.getAccessProfile({}, await options(["administrators"], "another-app")),
  ).rejects.toMatchObject({ code: Code.Unauthenticated });
  await expect(
    client.getAccessProfile({}, await options(["administrators"], undefined, "-1s")),
  ).rejects.toMatchObject({ code: Code.Unauthenticated });
  await expect(
    client.getAccessProfile({}, await options(["another-workspace"])),
  ).rejects.toMatchObject({ code: Code.PermissionDenied });
  expect((await client.getAccessProfile({}, await options(["readers"]))).profile).toMatchObject({
    workspace: "workspace",
    subject: "operator-1",
    operate: false,
    manage: false,
  });
  await expect(client.sendMessage({}, await options(["readers"]))).rejects.toMatchObject({
    code: Code.PermissionDenied,
  });
  await client.sendMessage({}, await options(["operators"]));
  await expect(client.updateRole({}, await options(["operators"]))).rejects.toMatchObject({
    code: Code.PermissionDenied,
  });
  await client.updateRole({}, await options(["administrators"]));
  expect(send).toHaveBeenCalledOnce();
  expect(update).toHaveBeenCalledOnce();
});

it("rejects a production or public listener authentication bypass", () => {
  expect(() =>
    authorizationConfig({ AGENTOS_AUTH_DISABLED_FOR_TESTS: "true", NODE_ENV: "production" }),
  ).toThrow();
  expect(() =>
    authorizationConfig({ AGENTOS_AUTH_DISABLED_FOR_TESTS: "true", AGENTOS_HOST: "0.0.0.0" }),
  ).toThrow();
  expect(() => authorizationConfig({})).toThrow();
});
