import Fastify from "fastify";
import { expect, it } from "vitest";
import { registerAppSandbox } from "../server/mcp-apps/sandbox.js";

it("serves only the proxy on the isolated origin and enforces restrictive HTTP policies", async () => {
  const app = Fastify();
  registerAppSandbox(app, "https://console.test", "https://sandbox.test");
  app.get("/private", () => ({ secret: "private" }));
  try {
    const response = await app.inject({
      url: "/mcp-app-sandbox",
      headers: { host: "sandbox.test" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-security-policy"]).toContain(
      "frame-ancestors https://console.test",
    );
    expect(response.headers["content-security-policy"]).toContain("connect-src 'none'");
    expect(response.headers["content-security-policy"]).not.toContain("unsafe-eval");
    expect(response.headers["permissions-policy"]).toContain("microphone=()");
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(
      (await app.inject({ url: "/private", headers: { host: "sandbox.test" } })).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          url: "/mcp-app-sandbox?csp=connect-src%20*",
          headers: { host: "sandbox.test" },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ url: "/mcp-app-sandbox", headers: { host: "console.test" } })).statusCode,
    ).toBe(404);
    const console = await app.inject({ url: "/private", headers: { host: "console.test" } });
    expect(console.headers["content-security-policy"]).toBe("frame-src https://sandbox.test");
  } finally {
    await app.close();
  }
});

it("rejects a sandbox on the console's origin", async () => {
  const app = Fastify();
  expect(() => registerAppSandbox(app, "https://console.test", "https://console.test")).toThrow(
    "separate origin",
  );
  await app.close();
});

it("supports data resource declarations without allowing any external origins", async () => {
  const app = Fastify();
  registerAppSandbox(app, "https://console.test", "https://sandbox.test");
  try {
    const response = await app.inject({
      url: "/mcp-app-sandbox?data=1",
      headers: { host: "sandbox.test" },
    });
    expect(response.headers["content-security-policy"]).toContain(
      "script-src 'self' 'unsafe-inline' data:",
    );
    expect(response.headers["content-security-policy"]).toContain("font-src data:");
    expect(response.headers["content-security-policy"]).toContain("connect-src 'none'");
  } finally {
    await app.close();
  }
});
