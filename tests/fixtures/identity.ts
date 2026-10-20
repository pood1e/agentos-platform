import { readFileSync } from "node:fs";
import { importPKCS8, SignJWT } from "jose";

export const identityIssuer = "https://127.0.0.1:8095";
export const testToken = await new SignJWT({ roles: ["writer"] })
  .setProtectedHeader({ alg: "RS256" })
  .setIssuer(identityIssuer)
  .setAudience("console")
  .setSubject("browser-test")
  .setIssuedAt()
  .setExpirationTime("1h")
  .sign(await importPKCS8(readFileSync("tests/fixtures/identity/tls.key", "utf8"), "RS256"));
