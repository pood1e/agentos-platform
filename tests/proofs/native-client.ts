import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { setTimeout } from "node:timers/promises";
import { create, toJson } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { Role, TaskState } from "../../gen/a2a_pb.js";
import { Control, CredentialHeaderSchema, HttpRuleEffectsSchema } from "../../gen/ateapi_pb.js";
import { actorTokenHeader } from "../../server/authorization/actor.js";
import { kagentClients, kagentTransport } from "../../server/kagent/clients.js";
import { object, text } from "../../server/read-model/decode/messages.js";
import { verifyGateway } from "./gateway-client.js";

const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const workspace = required("PROOF_WORKSPACE");
const userId = "authorization-proof";
const native = kagentClients(
  kagentTransport({ url: required("PROOF_KAGENT_URL"), namespace: workspace, userId }),
);
const substrateUrl = required("PROOF_SUBSTRATE_URL");
const substrate = createClient(
  Control,
  createGrpcTransport({
    baseUrl: substrateUrl,
    nodeOptions: {
      ca: readFileSync(required("PROOF_CA_FILE")),
      servername: process.env.PROOF_SUBSTRATE_SERVER_NAME ?? new URL(substrateUrl).hostname,
    },
    interceptors: [
      (next) => (request) => {
        request.header.set(
          "Authorization",
          `Bearer ${readFileSync(required("PROOF_TOKEN_FILE"), "utf8").trim()}`,
        );
        return next(request);
      },
    ],
  }),
);
const destination = new URL(required("PROOF_TOOL_ORIGIN"));
const port = Number(destination.port || (destination.protocol === "https:" ? 443 : 80));
const audience = `${destination.protocol}//${destination.hostname}:${port}`;
async function settled<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (
        attempt === 20 ||
        !(error instanceof ConnectError) ||
        ![Code.FailedPrecondition, Code.Aborted].includes(error.code)
      )
        throw error;
      await setTimeout(1_000);
    }
  }
}
const { session } = await native.sessions.createSession(
  {
    agent: { namespace: workspace, name: "authorization-proof" },
    requestId: randomUUID(),
    name: "Signed runtime identity proof",
  },
  { timeoutMs: 120_000 },
);
assert(session, "Native Session was not created");
console.log(JSON.stringify({ createdSession: session.id }));
let failure: unknown;
try {
  const actor = { atespace: workspace, name: `session-${session.id}` };
  const policy = await substrate.getActorEgressPolicy({ actor });
  let found = false;
  for (const rule of policy.rules) {
    const target = destination.protocol === "https:" ? rule.https : rule.http;
    if (!target?.hostnames.includes(destination.hostname) || !target.ports?.numbers.includes(port))
      continue;
    target.effects ??= create(HttpRuleEffectsSchema);
    target.effects.replaceHeaders = target.effects.replaceHeaders.filter(
      (header) => header.header.toLowerCase() !== actorTokenHeader,
    );
    target.effects.replaceHeaders.push(
      create(CredentialHeaderSchema, {
        header: actorTokenHeader,
        prefix: "Bearer ",
        actorJwt: { audiences: [audience], expirationSeconds: 300n },
      }),
    );
    found = true;
  }
  assert(found, "Proof origin must be declared by the Agent's compiled MCP configuration");
  await substrate.updateActorEgressPolicy({ actor, egressPolicy: policy });
  for (let turn = 0; turn < 2; turn++) {
    if (turn === 1) {
      await settled(() =>
        native.sessions.suspendSession({ sessionId: session.id }, { timeoutMs: 120_000 }),
      );
      await settled(() =>
        native.sessions.resumeSession({ sessionId: session.id }, { timeoutMs: 120_000 }),
      );
    }
    const nonce = randomUUID();
    const result = await native.a2a.sendMessage(
      {
        tenant: `${workspace}/authorization-proof`,
        message: {
          contextId: session.id,
          messageId: randomUUID(),
          role: Role.USER,
          parts: [
            {
              content: {
                case: "text",
                value: `Call inspect_identity now with resource="allowed" and nonce="${nonce}". Return the fresh tool result for this nonce.`,
              },
            },
          ],
        },
        configuration: { returnImmediately: false },
      },
      { timeoutMs: 120_000 },
    );
    assert(result.payload.case === "task", "Native invocation did not return a Task");
    assert.equal(result.payload.value.status?.state, TaskState.COMPLETED);
    const output = result.payload.value.artifacts
      .flatMap((artifact) => artifact.parts)
      .filter((part) => part.content.case === "data")
      .map((part) =>
        object(part.content.case === "data" ? toJson(ValueSchema, part.content.value) : undefined),
      )
      .find((value) => value.name === "inspect_identity" && value.response);
    assert(
      output,
      `No identity tool result on turn ${turn}: ${result.payload.value.artifacts
        .flatMap((artifact) => artifact.parts)
        .map((part) => (part.content.case === "text" ? part.content.value : ""))
        .join(" ")}`,
    );
    const verified = JSON.parse(text(object(output.response).output));
    assert.deepEqual(verified, {
      sessionId: session.id,
      agent: "authorization-proof",
      creator: userId,
      nonce,
    });
  }
  const { actorJwt } = await substrate.mintActorJwt({
    actor,
    audiences: [audience],
    expirationSeconds: 300n,
  });
  await verifyGateway(
    required("PROOF_GATEWAY_URL"),
    required("PROOF_EVIDENCE_URL"),
    actorJwt,
    session.id,
  );
  console.log(
    JSON.stringify({
      nativeAgentCalls: 2,
      signedSessionBindingVerified: true,
      restoredSession: true,
    }),
  );
} catch (error) {
  failure = error;
}
try {
  await settled(() =>
    native.sessions.deleteSession({ sessionId: session.id }, { timeoutMs: 120_000 }),
  );
} catch (error) {
  failure = failure
    ? new AggregateError([failure, error], `Proof Session ${session.id} remains`)
    : error;
}
if (failure) throw failure;
