import { createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:https";

const issuer = "https://127.0.0.1:8095";
const privateKey = readFileSync("tests/fixtures/identity/tls.key", "utf8");
const publicKey = createPublicKey(privateKey).export({ format: "jwk" });
createServer(
  { key: privateKey, cert: readFileSync("tests/fixtures/identity/tls.crt") },
  (request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify(
        ["/jwks", "/openid/v1/jwks"].includes(request.url ?? "")
          ? { keys: [{ ...publicKey, alg: "RS256", use: "sig" }] }
          : { issuer, jwks_uri: `${issuer}/jwks` },
      ),
    );
  },
).listen(8095, "127.0.0.1");
