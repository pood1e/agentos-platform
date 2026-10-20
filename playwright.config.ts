import { resolve } from "node:path";
import { defineConfig } from "@playwright/test";
import { identityIssuer, testToken } from "./tests/fixtures/identity.js";

const kagent = { port: "8093", control: "8094" };
const issuer = identityIssuer;
const token = testToken;

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 60_000,
  workers: 1,
  use: {
    locale: "zh-CN",
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:8090",
    viewport: { width: 1512, height: 982 },
    trace: "retain-on-failure",
    extraHTTPHeaders: process.env.PLAYWRIGHT_BASE_URL ? {} : { authorization: `Bearer ${token}` },
    launchOptions: {
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
      args: ["--no-proxy-server"],
    },
  },
  webServer: process.env.PLAYWRIGHT_BASE_URL
    ? undefined
    : [
        {
          command: "npx tsx tests/fake-identity.ts",
          url: `${issuer}/.well-known/openid-configuration`,
          ignoreHTTPSErrors: true,
          reuseExistingServer: false,
        },
        {
          command: "npx tsx tests/fake-kagent/server.ts",
          url: `http://127.0.0.1:${kagent.control}/healthz`,
          reuseExistingServer: false,
          env: { FAKE_KAGENT_PORT: kagent.port, FAKE_KAGENT_CONTROL_PORT: kagent.control },
        },
        {
          command: "npm start",
          url: "http://127.0.0.1:8090/readyz",
          reuseExistingServer: false,
          env: {
            AGENTOS_PORT: "8090",
            AGENTOS_AUTH_MODE: "oidc",
            AGENTOS_OIDC_ISSUER: issuer,
            AGENTOS_OIDC_CLIENT_ID: "console",
            AGENTOS_OIDC_AUDIENCE: "console",
            AGENTOS_OIDC_WRITER_ROLE: "writer",
            AGENTOS_ORIGIN: "http://127.0.0.1:8090",
            NODE_EXTRA_CA_CERTS: resolve("tests/fixtures/identity/tls.crt"),
            AGENTOS_MCP_TOKEN: "playwright-team-token",
            KAGENT_URL: `http://127.0.0.1:${kagent.port}`,
            AGENTOS_GATEWAY_URL: `http://127.0.0.1:${kagent.control}`,
            AGENTOS_GATEWAY_TOKEN: "test-gateway-token",
            AGENTOS_PACK_DIR: "tests/fixtures/pack",
            AGENTOS_TOOLSETS: "tests/fixtures/pack/toolsets.yaml",
            AGENTOS_PLATFORM_TOOLS: "tests/fixtures/execution/platform-tools.yaml",
            KUBECONFIG: "tests/fixtures/kubeconfig.yaml",
          },
        },
      ],
});
