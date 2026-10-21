import { createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { create } from "@bufbuild/protobuf";
import { createLocalJWKSet } from "jose";
import postgres from "postgres";
import { ExecutionIdentitySchema } from "../../gen/agentos/execution/v1/identity_pb.js";
import type { Session } from "../../gen/kagent/api/v1alpha1/sessions_pb.js";
import { executions } from "../../server/authorization/executions.js";
import { jwtIdentity } from "../../server/authorization/oidc.js";
import { executionStore } from "../../server/authorization/store.js";
import { allCapabilities } from "../../shared/permissions.js";
import { identityIssuer, testToken } from "./identity.js";

export const executionKey = Buffer.alloc(32, 1).toString("base64");

export async function fixtureExecutions() {
  const uri = process.env.CHANGE_TEST_DATABASE_URL;
  if (!uri) throw new Error("Browser tests require ci/with-postgres.sh");
  const store = await executionStore(uri, Buffer.from(executionKey, "base64"), "agentos");
  const sql = postgres(uri, { max: 1 });
  const key = createPublicKey(readFileSync("tests/fixtures/identity/tls.key")).export({
    format: "jwk",
  });
  const registry = executions(
    store,
    jwtIdentity(
      {
        issuer: identityIssuer,
        audience: "console",
        writerRole: "writer",
        origin: "http://127.0.0.1:8090",
      },
      createLocalJWKSet({ keys: [key] }),
    ),
  );
  const principal = create(ExecutionIdentitySchema, {
    subject: `${identityIssuer}#browser-test`,
    write: true,
    capabilities: allCapabilities,
    credential: { case: "accessToken", value: testToken },
  });
  return {
    created: async (session: Session, parent: Session) =>
      registry.bind(session, (await registry.resolve(parent)).identity, parent),
    seed: async (sessions: Session[], reset = false) => {
      if (reset) await sql`delete from agentos_authorization.objects where workspace='agentos'`;
      for (const session of sessions)
        await registry.bind(session, principal, session === sessions[0] ? undefined : sessions[0]);
    },
  };
}
