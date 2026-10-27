import { readFileSync } from "node:fs";
import { importPKCS8, SignJWT } from "jose";

export const identityIssuer = "https://127.0.0.1:8095";
const key = await importPKCS8(readFileSync("tests/fixtures/identity/tls.key", "utf8"), "RS256");

export function identityToken(roles: string[], subject: string) {
  return new SignJWT({ roles })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(identityIssuer)
    .setAudience("console")
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(key);
}
