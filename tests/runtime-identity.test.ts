import { randomUUID } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { Code, createClient, createRouterTransport } from "@connectrpc/connect";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { expect, it } from "vitest";
import { ActorSchema, Control } from "../gen/ateapi_pb.js";
import { SessionService } from "../gen/kagent/api/v1/sessions_pb.js";
import { actorVerifier, runtimeIdentity } from "../server/authorization/actor.js";

const issuer = "https://idp.ate-system.svc";
const audience = "agentos-runtime";

async function fixture() {
  const { publicKey, privateKey } = await generateKeyPair("ES256");
  const key = await exportJWK(publicKey);
  const verify = actorVerifier(
    createLocalJWKSet({ keys: [{ ...key, kid: "test" }] }),
    issuer,
    audience,
  );
  const id = randomUUID();
  const metadata = { atespace: "workspace", name: `session-${id}`, uid: randomUUID() };
  const claims = { atespace: metadata.atespace, actorName: metadata.name, actorUID: metadata.uid };
  const sign = (override: Record<string, unknown> = {}) =>
    new SignJWT({
      iss: issuer,
      sub: `actor/${metadata.atespace}/${metadata.name}`,
      aud: audience,
      iat: Math.floor(Date.now() / 1_000),
      nbf: Math.floor(Date.now() / 1_000) - 300,
      exp: Math.floor(Date.now() / 1_000) + 300,
      jti: randomUUID(),
      "actor.ate.dev": claims,
      ...override,
    })
      .setProtectedHeader({ alg: "ES256", kid: "test" })
      .sign(privateKey);
  return { id, metadata, claims, sign, verify, privateKey };
}

it("uses only signed native Actor fields and rejects worker, forged and wrong-audience credentials", async () => {
  const { verify, sign, metadata, claims } = await fixture();
  expect(await verify(await sign())).toMatchObject(metadata);
  for (const token of ["", "workspace/session/uid", "eyJhbGciOiJub25lIn0.e30."]) {
    await expect(verify(token)).rejects.toThrow("Runtime identity is invalid");
  }
  for (const claim of ["atespace", "actorName", "actorUID"]) {
    await expect(
      verify(await sign({ "actor.ate.dev": { ...claims, [claim]: "" } })),
    ).rejects.toThrow();
  }
  for (const options of [
    { sub: `worker-for-actor/${metadata.atespace}/${metadata.name}`, aud: audience, iss: issuer },
    { sub: `actor/${metadata.atespace}/another`, aud: audience, iss: issuer },
    { sub: `actor/${metadata.atespace}/${metadata.name}`, aud: "another-service", iss: issuer },
    { sub: `actor/${metadata.atespace}/${metadata.name}`, aud: audience, iss: "https://another" },
  ]) {
    await expect(verify(await sign(options))).rejects.toThrow("Runtime identity is invalid");
  }
});

it.each(["ate.dev", "worker-for-actor.ate.dev"])("rejects the %s identity claim", async (claim) => {
  const { verify, sign, claims } = await fixture();
  await expect(verify(await sign({ "actor.ate.dev": undefined, [claim]: claims }))).rejects.toThrow(
    "Runtime identity is invalid",
  );
});

it("rejects unknown signers, expired tokens and missing required claims", async () => {
  const { verify, sign } = await fixture();
  const other = await fixture();
  await expect(verify(await other.sign())).rejects.toThrow("Runtime identity is invalid");
  await expect(verify(await sign({ exp: 1 }))).rejects.toThrow("Runtime identity is invalid");
  for (const claim of ["iat", "nbf", "exp", "jti", "sub", "iss", "aud"])
    await expect(verify(await sign({ [claim]: undefined }))).rejects.toThrow();
});

it("reports a signing-key outage as unavailable rather than a rejected identity", async () => {
  const { sign } = await fixture();
  const verify = actorVerifier(
    async () => {
      throw new Error("JWKS upstream down");
    },
    issuer,
    audience,
  );
  await expect(verify(await sign())).rejects.toMatchObject({ code: Code.Unavailable });
});

it("binds the native Session and rejects a cached token after Actor replacement", async () => {
  const { verify, sign, id, metadata } = await fixture();
  const native = createClient(
    Control,
    createRouterTransport((router) =>
      router.service(Control, { getActor: () => create(ActorSchema, { metadata }) }),
    ),
  );
  const sessions = createClient(
    SessionService,
    createRouterTransport((router) =>
      router.service(SessionService, {
        getSession: () => ({
          session: { id, creator: "owner", agent: { namespace: "workspace", name: "agent" } },
        }),
      }),
    ),
  );
  const identity = runtimeIdentity(verify, native, sessions, "workspace");
  const token = await sign();
  expect(await identity(token)).toMatchObject({ id, creator: "owner" });
  metadata.uid = randomUUID();
  await expect(identity(token)).rejects.toThrow("Runtime identity is invalid");
  await expect(runtimeIdentity(verify, native, sessions, "another")(token)).rejects.toThrow();
});
