import type { FastifyInstance } from "fastify";

// Relay based on the MCP Apps reference host. AppBridge owns JSON-RPC handling.
function sandboxProxy(consoleOrigin: string) {
  if (window.self === window.top || new URL(document.referrer).origin !== consoleOrigin)
    throw new Error("Invalid MCP App embedding origin");
  const inner = document.createElement("iframe");
  inner.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms");
  inner.style.cssText = "width:100%;height:100%;border:0";
  document.body.append(inner);
  window.addEventListener("message", (event: MessageEvent) => {
    if (event.source === window.parent && event.origin === consoleOrigin) {
      if (event.data?.method === "ui/notifications/sandbox-resource-ready") {
        const html = event.data.params?.html;
        if (typeof html === "string") inner.srcdoc = html;
      } else inner.contentWindow?.postMessage(event.data, window.location.origin);
    } else if (event.source === inner.contentWindow && event.origin === window.location.origin) {
      window.parent.postMessage(event.data, consoleOrigin);
    }
  });
  window.parent.postMessage(
    { jsonrpc: "2.0", method: "ui/notifications/sandbox-proxy-ready", params: {} },
    consoleOrigin,
  );
}

export function registerAppSandbox(
  app: FastifyInstance,
  consoleOrigin: string,
  sandboxOrigin: string,
) {
  if (!sandboxOrigin) return;
  const host = new URL(sandboxOrigin);
  const consoleURL = new URL(consoleOrigin);
  if (
    host.origin === consoleURL.origin ||
    !["http:", "https:"].includes(host.protocol) ||
    host.href !== `${host.origin}/`
  )
    throw new Error("MCP App sandbox requires a separate origin");
  const csp = (data: boolean) =>
    [
      "default-src 'none'",
      `script-src 'self' 'unsafe-inline'${data ? " data:" : ""}`,
      `style-src 'self' 'unsafe-inline'${data ? " data:" : ""}`,
      "img-src 'self' data:",
      "media-src 'self' data:",
      data ? "font-src data:" : "font-src 'none'",
      "connect-src 'none'",
      "worker-src 'none'",
      "frame-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
      `frame-ancestors ${consoleURL.origin}`,
    ].join("; ");
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;height:100%;overflow:hidden}</style></head><body><script>(${sandboxProxy.toString()})(${JSON.stringify(consoleURL.origin)})</script></body></html>`;
  app.addHook("onRequest", async (request, reply) => {
    if (request.headers.host?.toLowerCase() !== host.host) {
      reply.header("Content-Security-Policy", `frame-src ${host.origin}`);
      if (request.url.split("?")[0] === "/mcp-app-sandbox") return reply.code(404).send();
      return;
    }
    if (
      request.method !== "GET" ||
      !["/mcp-app-sandbox", "/mcp-app-sandbox?data=1"].includes(request.url)
    )
      return reply.code(404).send();
    return reply
      .header("Content-Security-Policy", csp(request.url.endsWith("?data=1")))
      .header("Permissions-Policy", "camera=(), microphone=(), geolocation=(), clipboard-write=()")
      .header("Cache-Control", "no-store")
      .header("X-Content-Type-Options", "nosniff")
      .header("Referrer-Policy", "no-referrer")
      .type("text/html; charset=utf-8")
      .send(html);
  });
}
