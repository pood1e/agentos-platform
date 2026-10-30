import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";

it("restricts each view to its declared HTTPS images under the site CSP", () => {
  const source = readFileSync("web/mcp-app-sandbox.html", "utf8");
  const script = source.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  if (!script) throw new Error("Sandbox relay script missing");
  const inner = { setAttribute() {}, style: { cssText: "" }, contentWindow: {}, srcdoc: "" };
  const parent = { postMessage() {} };
  const listeners: Record<string, (event: unknown) => void> = {};
  const window = {
    self: {},
    top: {},
    parent,
    location: { origin: "https://sandbox.example" },
    addEventListener: (name: string, fn: (event: unknown) => void) => {
      listeners[name] = fn;
    },
  };
  const document = {
    referrer: "https://console.example/page",
    body: { append() {} },
    createElement(name: string) {
      if (name === "iframe") return inner;
      return {
        httpEquiv: "",
        content: "",
        get outerHTML() {
          return `<meta content="${this.content}">`;
        },
      };
    },
  };
  runInNewContext(script.replace("__AGENTOS_CONSOLE_ORIGIN__", "https://console.example"), {
    window,
    document,
    URL,
  });
  listeners.message({
    source: parent,
    origin: "https://console.example",
    data: {
      method: "ui/notifications/sandbox-resource-ready",
      params: {
        html: "<html>view</html>",
        csp: {
          resourceDomains: [
            "https://icons.example",
            "https://evil.example/path",
            "http://bad.example",
            "https://u:p@secret.example",
            "data:",
          ],
        },
      },
    },
  });
  expect(inner.srcdoc).toContain("img-src 'self' data: https://icons.example");
  expect(inner.srcdoc).not.toContain("evil.example");
  expect(inner.srcdoc).not.toContain("secret.example");
  const config = readFileSync("web/templates/default.conf.template", "utf8");
  const origins = "$" + "{AGENTOS_MCP_IMAGE_ORIGINS}";
  expect(config).toContain(`img-src 'self' data: ${origins}`);
  expect(config).toContain("connect-src 'none'");
  expect(config).not.toContain(`script-src ${origins}`);
});
