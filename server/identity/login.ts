import { createHash, timingSafeEqual } from "node:crypto";
import formbody from "@fastify/formbody";
import middie from "@fastify/middie";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type Provider from "oidc-provider";
import { RateLimiterMemory, type RateLimiterRes } from "rate-limiter-flexible";
import { siteAccount } from "./provider.js";

const messages = {
  en: {
    password: "Password",
    submit: "Sign in",
    invalid: "Incorrect password.",
    limited: "Too many attempts. Try again later.",
    expired: "The sign-in request expired. Return to the application and try again.",
  },
  zh: {
    password: "密码",
    submit: "登录",
    invalid: "密码错误。",
    limited: "尝试次数过多，请稍后再试。",
    expired: "登录请求已过期，请返回应用重试。",
  },
};
type Message = Exclude<keyof (typeof messages)["en"], "password" | "submit">;

function page(request: FastifyRequest, reply: FastifyReply, status: number, error?: Message) {
  const locale = /^zh\b/i.test(request.headers["accept-language"] ?? "") ? "zh" : "en";
  const text = messages[locale];
  const form =
    error === "expired"
      ? ""
      : `<input type="password" name="password" aria-label="${text.password}" placeholder="${text.password}" autocomplete="current-password" required autofocus><button>${text.submit}</button>`;
  return reply
    .code(status)
    .header(
      "content-security-policy",
      "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
    )
    .header("cache-control", "no-store")
    .type("text/html; charset=utf-8")
    .send(
      `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AgentOS</title><style>body{font:16px system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0}form{display:grid;gap:12px;width:min(320px,90vw)}input,button{font:inherit;padding:8px 12px}</style></head><body><form method="post"><h1>AgentOS</h1>${error ? `<p role="alert">${text[error]}</p>` : ""}${form}</form></body></html>`,
    );
}

const blocked = (state: RateLimiterRes | null, points: number) =>
  (state?.consumedPoints ?? 0) >= points;
const digest = (value: string) => createHash("sha256").update(value).digest();

/** Mounts the provider under its issuer path; interactions accept only the site password. */
export async function registerIdentity(
  app: FastifyInstance,
  provider: Provider,
  prefix: string,
  password: string,
) {
  const expected = digest(password);
  const attempts = { address: 5, site: 100 };
  const failures = {
    address: new RateLimiterMemory({
      points: attempts.address,
      duration: 900,
      blockDuration: 900,
    }),
    site: new RateLimiterMemory({ points: attempts.site, duration: 3600 }),
  };
  const callback = provider.callback();
  await app.register(middie);
  await app.register(formbody);
  app.use(prefix, (request, response, next) =>
    request.url?.startsWith("/interaction/") ? next() : callback(request, response),
  );
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof Error && error.name === "SessionNotFound")
      return page(request, reply, 400, "expired");
    request.log.error(error);
    return reply.code(500).send();
  });

  app.get<{ Params: { uid: string } }>(`${prefix}/interaction/:uid`, async (request, reply) => {
    const { prompt, params, session, grantId } = await provider.interactionDetails(
      request.raw,
      reply.raw,
    );
    if (prompt.name === "login") return page(request, reply, 200);
    // The only registered client is first-party, so consent grants what it requested.
    const grant = grantId
      ? await provider.Grant.find(grantId)
      : new provider.Grant({ accountId: session?.accountId, clientId: String(params.client_id) });
    if (!grant) throw new Error("Grant is missing");
    const { missingOIDCScope, missingOIDCClaims, missingResourceScopes } = prompt.details as {
      missingOIDCScope?: string[];
      missingOIDCClaims?: string[];
      missingResourceScopes?: Record<string, string[]>;
    };
    if (missingOIDCScope) grant.addOIDCScope(missingOIDCScope.join(" "));
    if (missingOIDCClaims) grant.addOIDCClaims(missingOIDCClaims);
    for (const [indicator, scopes] of Object.entries(missingResourceScopes ?? {}))
      grant.addResourceScope(indicator, scopes.join(" "));
    const consent = { grantId: await grant.save() };
    reply.hijack();
    await provider.interactionFinished(
      request.raw,
      reply.raw,
      { consent },
      { mergeWithLastSubmission: true },
    );
  });

  app.post<{ Params: { uid: string }; Body: { password?: string } }>(
    `${prefix}/interaction/:uid`,
    { bodyLimit: 4096 },
    async (request, reply) => {
      const { prompt } = await provider.interactionDetails(request.raw, reply.raw);
      if (prompt.name !== "login") return reply.code(400).send();
      const [address, site] = await Promise.all([
        failures.address.get(request.ip),
        failures.site.get(siteAccount),
      ]);
      if (blocked(address, attempts.address) || blocked(site, attempts.site))
        return page(request, reply, 429, "limited");
      if (!timingSafeEqual(digest(request.body?.password ?? ""), expected)) {
        await Promise.allSettled([
          failures.address.consume(request.ip),
          failures.site.consume(siteAccount),
        ]);
        return page(request, reply, 401, "invalid");
      }
      await failures.address.delete(request.ip);
      reply.hijack();
      await provider.interactionFinished(
        request.raw,
        reply.raw,
        { login: { accountId: siteAccount } },
        { mergeWithLastSubmission: false },
      );
    },
  );
}
