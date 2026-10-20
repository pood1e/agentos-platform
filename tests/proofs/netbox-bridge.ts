import assert from "node:assert/strict";
import { lookup } from "node:dns";
import { readFileSync } from "node:fs";
import { Agent, fetch } from "undici";

const baseUrl = process.env.PROOF_NETBOX_URL;
const tokenFile = process.env.PROOF_NETBOX_TOKEN_FILE;
if (!baseUrl || !tokenFile) throw new Error("NetBox URL and reader token file are required");
if (new URL(baseUrl).protocol !== "https:") throw new Error("NetBox proof requires HTTPS");
const dispatcher = new Agent({
  connect: {
    lookup: (host, options, callback) =>
      lookup(process.env.PROOF_NETBOX_ADDRESS ?? host, options, callback),
  },
});
const token = readFileSync(tokenFile, "utf8").trim();
const request = (path: string, method = "GET", body?: object) =>
  fetch(new URL(path, baseUrl), {
    method,
    dispatcher,
    redirect: "error",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
try {
  const read = await request("/api/dcim/sites/?limit=1");
  assert.equal(read.status, 200, "Native inventory read was denied");
  const sites = (await read.json()) as { results?: unknown };
  assert(Array.isArray(sites.results), "Native inventory response is invalid");
  const write = await request("/api/dcim/sites/0/", "PATCH", { name: "permission-probe" });
  assert.equal(write.status, 403, "Reader token did not reject the write before object lookup");
  console.log(
    JSON.stringify({
      authenticationMode: "service-identity-bridge",
      nativeReadAllowed: true,
      nativeWriteDenied: true,
    }),
  );
} finally {
  await dispatcher.close();
}
