import { readFileSync } from "node:fs";
import Fastify from "fastify";
import { listenConfig, requiredEnv } from "../shared/config.js";
import { registerIdentity } from "./login.js";
import { identityProvider } from "./provider.js";
import { artifactStore } from "./store.js";

const store = await artifactStore(
  requiredEnv("AGENTOS_IDENTITY_DATABASE_URL"),
  process.env.AGENTOS_IDENTITY_DATABASE_CA
    ? readFileSync(process.env.AGENTOS_IDENTITY_DATABASE_CA, "utf8")
    : undefined,
);
const { provider, prefix } = await identityProvider(
  {
    issuer: requiredEnv("AGENTOS_IDENTITY_ISSUER"),
    audience: requiredEnv("AGENTOS_IDENTITY_AUDIENCE"),
    writerRole: requiredEnv("AGENTOS_IDENTITY_WRITER_ROLE"),
    clientId: requiredEnv("AGENTOS_IDENTITY_CLIENT_ID"),
    clientSecret: requiredEnv("AGENTOS_IDENTITY_CLIENT_SECRET"),
    redirectUris: JSON.parse(requiredEnv("AGENTOS_IDENTITY_REDIRECT_URIS")),
    signingKey: requiredEnv("AGENTOS_IDENTITY_SIGNING_KEY"),
    cookieKey: requiredEnv("AGENTOS_IDENTITY_COOKIE_KEY"),
  },
  store.adapter,
);
// Only the gateway in front is trusted to report the client address.
const app = Fastify({ logger: true, trustProxy: (_address, hop) => hop < 1 });
await registerIdentity(app, provider, prefix, requiredEnv("AGENTOS_IDENTITY_PASSWORD"));
app.get("/healthz", async () => ({ status: "ok" }));
app.addHook("onClose", () => store.close());
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => void app.close());
await app.listen(listenConfig());
