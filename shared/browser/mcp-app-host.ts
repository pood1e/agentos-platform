import type { CallToolResult } from "@modelcontextprotocol/client";
import { ReadResourceResultSchema } from "@modelcontextprotocol/core";
import {
  AppBridge,
  type McpUiHostContext,
  PostMessageTransport,
} from "@modelcontextprotocol/ext-apps/app-bridge";
import { appResourcePolicy } from "../mcp-apps-policy.js";

export interface AppHostSnapshot {
  input: { arguments: Record<string, unknown> };
  result?: CallToolResult;
  canceled: boolean;
}

/** Owns the official bridge lifecycle; framework adapters provide RPCs, theme and controls. */
export function mountMcpApp(options: {
  frame: HTMLIFrameElement;
  resource: unknown;
  sandboxOrigin: string;
  context: McpUiHostContext;
  signal: AbortSignal;
  snapshot: () => AppHostSnapshot;
  cancellationReason: () => string;
  onCallTool: NonNullable<AppBridge["oncalltool"]>;
  onMessage?: (text: string) => void;
  onDisplayMode: NonNullable<AppBridge["onrequestdisplaymode"]>;
  onSizeChange: (height: number) => void;
  onReady: () => void;
  onError: () => void;
}) {
  const origin = new URL(options.sandboxOrigin).origin;
  if (!/^https?:/.test(origin) || origin === window.location.origin)
    throw new Error("MCP Apps require an independent sandbox origin");
  const target = options.frame.contentWindow;
  if (!target) throw new Error("MCP App frame is unavailable");
  const resource = ReadResourceResultSchema.parse(options.resource).contents[0];
  if (!resource) throw new Error("Empty MCP App resource");
  const html =
    "text" in resource
      ? resource.text
      : new TextDecoder().decode(
          Uint8Array.from(atob(resource.blob), (char) => char.charCodeAt(0)),
        );
  const csp = appResourcePolicy(resource._meta?.ui);
  const bridge = new AppBridge(
    null,
    { name: "AgentOS", version: "1.0.0" },
    {
      serverTools: {},
      openLinks: {},
      ...(options.onMessage ? { message: { text: {} } } : {}),
      sandbox: { csp, permissions: {} },
    },
    { hostContext: options.context },
  );
  let closed = false,
    initialized = false,
    sent = false;
  const failed = () => {
    if (!closed && !options.signal.aborted) {
      close();
      options.onError();
    }
  };
  const timeout = window.setTimeout(failed, 10_000);
  const guard = (event: MessageEvent) => {
    if (event.source === target && event.origin !== origin) event.stopImmediatePropagation();
  };
  window.addEventListener("message", guard, true);
  const publish = () => {
    const value = options.snapshot();
    if (closed || !initialized || sent || (!value.result && !value.canceled)) return;
    sent = true;
    const notification = value.canceled
      ? bridge.sendToolCancelled({ reason: options.cancellationReason() })
      : value.result && bridge.sendToolResult(value.result);
    void notification?.catch(failed);
  };
  bridge.onsandboxready = () => {
    void bridge.sendSandboxResourceReady({ html, csp }).catch(failed);
  };
  bridge.oninitialized = () => {
    void bridge
      .sendToolInput(options.snapshot().input)
      .then(() => {
        if (closed || options.signal.aborted) return;
        window.clearTimeout(timeout);
        initialized = true;
        options.onReady();
        publish();
      })
      .catch(failed);
  };
  bridge.onsizechange = ({ height }) => {
    if (height && Number.isFinite(height))
      options.onSizeChange(Math.max(180, Math.min(680, height)));
  };
  bridge.oncalltool = options.onCallTool;
  bridge.onrequestdisplaymode = options.onDisplayMode;
  bridge.onopenlink = async ({ url }) => {
    const target = new URL(url);
    if (!["http:", "https:"].includes(target.protocol))
      throw new Error("Unsupported link protocol");
    window.open(target.href, "_blank", "noopener,noreferrer");
    return {};
  };
  if (options.onMessage)
    bridge.onmessage = async ({ content }) => {
      if (content.some((part) => part.type !== "text"))
        throw new Error("Only text messages are supported");
      options.onMessage?.(
        content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n"),
      );
      return {};
    };
  const close = () => {
    if (closed) return;
    closed = true;
    window.clearTimeout(timeout);
    window.removeEventListener("message", guard, true);
    options.signal.removeEventListener("abort", close);
    void bridge.close().catch(() => {});
  };
  bridge.onerror = failed;
  bridge.onclose = failed;
  options.signal.addEventListener("abort", close, { once: true });
  if (options.signal.aborted) close();
  else
    void bridge
      .connect(new PostMessageTransport(target, target))
      .then(() => {
        if (closed) return;
        const url = new URL("/mcp-app-sandbox", origin);
        if (csp.resourceDomains?.includes("data:")) url.searchParams.set("data", "1");
        options.frame.src = url.href;
      })
      .catch(failed);
  return { bridge, publish, close };
}
