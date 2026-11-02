import secureSession from "@fastify/secure-session";
import type { FastifyInstance } from "fastify";
import * as oidc from "openid-client";
import type { KagentClients } from "../kagent/clients.js";

interface DelegationRequest {
  verifier: string;
  state: string;
  nonce: string;
  returnTo: string;
  namespace: string;
  uid: string;
  started: number;
}

declare module "@fastify/secure-session" {
  interface SessionData {
    delegation: DelegationRequest;
  }
}

const lifetime = 10 * 60_000;

export function delegationWorkspace(
  returnTo: string,
  origins: readonly string[],
  namespaces: ReadonlySet<string>,
) {
  try {
    const url = new URL(returnTo);
    const path = /^\/w\/([^/]+)\/([^/]+)(?:\/|$)/.exec(url.pathname);
    if (!origins.includes(url.origin) || !path) return;
    const namespace = decodeURIComponent(path[1]);
    const uid = decodeURIComponent(path[2]);
    return uid && namespaces.has(namespace) ? { namespace, uid } : undefined;
  } catch {
    return;
  }
}

/** Users authorize background execution once on the API origin; any client links to the start. */
export async function registerDelegation(
  app: FastifyInstance,
  config: {
    origin: string;
    returnOrigins: string[];
    client: oidc.Configuration;
    key: Buffer;
    clients: ReadonlyMap<string, KagentClients>;
  },
) {
  await app.register(secureSession, {
    cookieName: "__Host-agentos-delegation",
    key: config.key,
    expiry: lifetime / 1000,
    cookie: { path: "/", secure: true, httpOnly: true, sameSite: "lax" },
  });
  app.get<{ Querystring: { return_to?: string } }>("/delegation/start", async (request, reply) => {
    const returnTo = request.query.return_to ?? "";
    const workspace = delegationWorkspace(
      returnTo,
      config.returnOrigins,
      new Set(config.clients.keys()),
    );
    if (!workspace) return reply.code(400).send({ message: "Unregistered return address" });
    const verifier = oidc.randomPKCECodeVerifier();
    const state = oidc.randomState();
    const nonce = oidc.randomNonce();
    request.session.set("delegation", {
      verifier,
      state,
      nonce,
      returnTo,
      ...workspace,
      started: Date.now(),
    });
    const url = oidc.buildAuthorizationUrl(config.client, {
      redirect_uri: `${config.origin}/delegation/callback`,
      scope: "openid offline_access",
      // OpenID Connect grants offline access only with explicit consent.
      prompt: "consent",
      code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
      code_challenge_method: "S256",
      state,
      nonce,
    });
    return reply.header("cache-control", "no-store").redirect(url.href);
  });

  app.get("/delegation/callback", async (request, reply) => {
    const pending = request.session.get("delegation");
    request.session.delete();
    reply.header("cache-control", "no-store");
    if (!pending || Date.now() - pending.started > lifetime)
      return reply.code(401).send({ message: "Delegation request expired" });
    try {
      const tokens = await oidc.authorizationCodeGrant(
        config.client,
        new URL(request.url, config.origin),
        {
          pkceCodeVerifier: pending.verifier,
          expectedState: pending.state,
          expectedNonce: pending.nonce,
        },
      );
      if (!tokens.refresh_token) throw new Error("Renewable delegation credential required");
      const clients = config.clients.get(pending.namespace);
      if (!clients) throw new Error("Workspace authority unavailable");
      const headers = { authorization: `Bearer ${tokens.access_token}` };
      const member = await clients.authorization.listWorkspaces(
        { workspace: { namespace: pending.namespace, uid: pending.uid } },
        { headers, timeoutMs: 10_000 },
      );
      if (
        member.workspaces.length !== 1 ||
        member.workspaces[0]?.namespace !== pending.namespace ||
        member.workspaces[0]?.uid !== pending.uid
      )
        throw new Error("Workspace membership required");
      await clients.execution.registerDelegationCredential(
        { refreshToken: tokens.refresh_token },
        {
          headers,
          timeoutMs: 30_000,
        },
      );
    } catch {
      return reply.code(401).send({ message: "Delegation failed" });
    }
    return pending.returnTo
      ? reply.redirect(pending.returnTo)
      : reply.type("text/plain; charset=utf-8").send("Background execution is authorized.");
  });
}
