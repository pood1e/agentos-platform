import { defineConfig } from "@playwright/test";

const kagent = { port: "8093", control: "8094" };

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 60_000,
  workers: 1,
  use: {
    locale: "zh-CN",
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:8090",
    viewport: { width: 1512, height: 982 },
    trace: "retain-on-failure",
    launchOptions: {
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
      args: ["--no-proxy-server"],
    },
  },
  webServer: process.env.PLAYWRIGHT_BASE_URL
    ? undefined
    : [
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
            KAGENT_URL: `http://127.0.0.1:${kagent.port}`,
            AGENTOS_GATEWAY_URL: `http://127.0.0.1:${kagent.control}`,
            AGENTOS_GATEWAY_TOKEN: "test-gateway-token",
            AGENTOS_PACK_DIR: "tests/fixtures/pack",
            AGENTOS_TOOLSETS: "tests/fixtures/pack/toolsets.yaml",
            AGENTOS_PLATFORM_TOOLS: "tests/fixtures/execution/platform-tools.yaml",
            KUBECONFIG: "tests/fixtures/kubeconfig.yaml",
          },
        },
        {
          command: "npm run start:team-sessions",
          url: "http://127.0.0.1:8091/readyz",
          reuseExistingServer: false,
          env: {
            AGENTOS_PORT: "8091",
            KAGENT_URL: `http://127.0.0.1:${kagent.port}`,
            AGENTOS_MCP_TOKEN: "playwright-team-token",
            AGENTOS_TOOLSETS: "tests/fixtures/pack/toolsets.yaml",
            AGENTOS_PLATFORM_TOOLS: "tests/fixtures/execution/platform-tools.yaml",
            KUBECONFIG: "tests/fixtures/kubeconfig.yaml",
          },
        },
      ],
});
