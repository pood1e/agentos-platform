import secureSession from "@fastify/secure-session";
import type { FastifyInstance } from "fastify";
import * as oidc from "openid-client";
import type { Executions } from "./executions.js";
import type { OfflineCredentials } from "./offline.js";

interface LoginRequest {
  verifier: string;
  state: string;
  nonce: string;
  started: number;
}

declare module "@fastify/secure-session" {
  interface SessionData {
    login: LoginRequest;
    subject: string;
  }
}

export async function registerBrowserIdentity(
  app: FastifyInstance,
  config: {
    origin: string;
    client: oidc.Configuration;
    key: Buffer;
    grants: OfflineCredentials;
    executions: Executions;
  },
) {
  await app.register(secureSession, {
    cookieName: "__Host-agentos",
    key: config.key,
    expiry: 8 * 3600,
    cookie: { path: "/", secure: true, httpOnly: true, sameSite: "lax" },
  });

  app.get("/auth/start", async (request, reply) => {
    const verifier = oidc.randomPKCECodeVerifier();
    const state = oidc.randomState();
    const nonce = oidc.randomNonce();
    request.session.set("login", {
      verifier,
      state,
      nonce,
      started: Date.now(),
    } satisfies LoginRequest);
    const url = oidc.buildAuthorizationUrl(config.client, {
      redirect_uri: `${config.origin}/auth/callback`,
      scope: "openid profile email offline_access",
      code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
      code_challenge_method: "S256",
      state,
      nonce,
    });
    return reply.header("cache-control", "no-store").redirect(url.href);
  });

  app.get("/auth/callback", async (request, reply) => {
    const login = request.session.get("login");
    request.session.set("login", undefined);
    if (!login || Date.now() - login.started > 10 * 60_000)
      return reply.code(401).send({ message: "Login request expired" });
    try {
      const tokens = await oidc.authorizationCodeGrant(
        config.client,
        new URL(request.url, config.origin),
        {
          pkceCodeVerifier: login.verifier,
          expectedState: login.state,
          expectedNonce: login.nonce,
        },
      );
      const identity = await config.executions.remember(await config.grants.accept(tokens), true);
      request.session.regenerate();
      request.session.set("subject", identity.subject);
      return reply.header("cache-control", "no-store").redirect("/");
    } catch {
      return reply.code(401).send({ message: "Login authorization failed" });
    }
  });

  app.post("/auth/logout", async (request, reply) => {
    if (request.headers.origin !== config.origin) return reply.code(403).send();
    request.session.delete();
    return reply.code(204).header("cache-control", "no-store").send();
  });

  app.addHook("onRequest", async (request, reply) => {
    delete request.headers["x-forwarded-access-token"];
    if (request.url.startsWith("/auth/") || request.headers.authorization) return;
    const subject = request.session.get("subject");
    if (subject) {
      try {
        const identity = await config.grants.resolve(subject);
        if (identity?.credential.case !== "accessToken") throw new Error("Missing delegation");
        request.headers["x-forwarded-access-token"] = identity.credential.value;
        return;
      } catch {
        request.session.delete();
        return reply.code(401).send({ code: "unauthenticated", message: "Login required" });
      }
    }
    if (request.method === "GET" && request.headers.accept?.includes("text/html"))
      return reply.header("cache-control", "no-store").redirect("/auth/start");
  });
}
