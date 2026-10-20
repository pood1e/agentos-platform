import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { actorTokenHeader } from "../../server/authorization/actor.js";

export async function verifyGateway(
  url: string,
  evidenceUrl: string,
  token: string,
  sessionId: string,
) {
  const evidence = async () => {
    const response = await fetch(evidenceUrl, { signal: AbortSignal.timeout(5_000) });
    assert(response.ok, "Proof evidence endpoint is unavailable");
    return response.json() as Promise<{
      acceptedCalls: number;
      lastSessionId: string;
      checkedCalls: Array<{ sessionId: string; tool: string; resource: string }>;
    }>;
  };
  const client = new Client({ name: "authorization-proof", version: "1.0.0" });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { [actorTokenHeader]: `Bearer ${token}` } },
      }),
    );
    const before = await evidence();
    const invoke = (resource: string) =>
      client.callTool({
        name: "inspect_identity",
        arguments: { resource, session_id: "forged-session", initiator: "administrator" },
      });
    const allowed = await invoke("allowed");
    assert(!allowed.isError, "Allowed call failed");
    const afterAllowed = await evidence();
    assert.equal(afterAllowed.acceptedCalls, before.acceptedCalls + 1);
    assert.equal(afterAllowed.lastSessionId, sessionId);
    const denied = await invoke("outside-scope");
    assert.equal(denied.isError, true, "Out-of-scope call was allowed");
    const afterDenied = await evidence();
    assert.equal(afterDenied.acceptedCalls, afterAllowed.acceptedCalls);
    assert.deepEqual(afterDenied.checkedCalls.slice(-2), [
      { sessionId, tool: "inspect_identity", resource: "allowed" },
      { sessionId, tool: "inspect_identity", resource: "outside-scope" },
    ]);
    console.log(JSON.stringify({ perCallAuthorization: true, deniedCallReachedUpstream: false }));
  } finally {
    await client.close();
  }
}

if (import.meta.main) {
  const url = process.env.PROOF_GATEWAY_URL;
  const evidenceUrl = process.env.PROOF_EVIDENCE_URL;
  const tokenFile = process.env.PROOF_ACTOR_TOKEN_FILE;
  const sessionId = process.env.PROOF_SESSION_ID;
  if (!url || !evidenceUrl || !tokenFile || !sessionId)
    throw new Error("Proof gateway, evidence URL, Actor token file and Session ID are required");
  await verifyGateway(url, evidenceUrl, readFileSync(tokenFile, "utf8").trim(), sessionId);
}
