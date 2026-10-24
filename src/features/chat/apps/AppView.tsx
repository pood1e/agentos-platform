import { create, type JsonObject } from "@bufbuild/protobuf";
import type { CallToolResult } from "@modelcontextprotocol/client";
import { CallToolResultSchema, ReadResourceResultSchema } from "@modelcontextprotocol/core";
import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";
import { Maximize2, Minimize2 } from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  type AppView as AppInput,
  type AppReference,
  AppReferenceSchema,
} from "../../../../gen/agentos/mcp/v1/app_pb.js";
import { appResourcePolicy } from "../../../../shared/mcp-apps-policy.js";
import { consoleClient } from "../../../lib/console.js";
import { ToolIcon } from "../../shared/ToolIcon.js";
import { useToolText } from "../../shared/use-tool-text.js";
import { hostContext } from "./host-context.js";

export function AppView({
  reference,
  input,
  result,
  canceled = false,
  onMessage,
}: {
  reference: AppReference;
  input: AppInput;
  result?: CallToolResult;
  canceled?: boolean;
  onMessage?: (text: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const { resolvedTheme } = useTheme();
  const taskId = reference.taskId;
  const source = reference.origin;
  const canMessage = Boolean(onMessage);
  const label = useToolText()(input.tool);
  const container = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const bridge = useRef<AppBridge | undefined>(undefined);
  const latest = useRef({ input, result, canceled });
  const deliver = useRef<() => void>(() => {});
  const [height, setHeight] = useState(360);
  const [fullscreen, setFullscreen] = useState(false);
  const [error, setError] = useState(false);
  const currentContext = useEffectEvent(() =>
    hostContext(resolvedTheme, i18n.language, fullscreen),
  );
  const cancellationReason = useEffectEvent(() => t("activity.canceled"));
  const message = useEffectEvent((text: string) => {
    if (!onMessage) throw new Error("Text input is unavailable");
    onMessage(text);
  });
  useEffect(() => {
    const changed = () => setFullscreen(document.fullscreenElement === container.current);
    document.addEventListener("fullscreenchange", changed);
    return () => document.removeEventListener("fullscreenchange", changed);
  }, []);
  useEffect(() => {
    bridge.current?.setHostContext(hostContext(resolvedTheme, i18n.language, fullscreen));
  }, [resolvedTheme, i18n.language, fullscreen]);
  useEffect(() => {
    latest.current = { input, result, canceled };
    deliver.current();
  }, [input, result, canceled]);
  useEffect(() => {
    if (!source.case) return;
    const app = create(AppReferenceSchema, {
      taskId,
      origin:
        source.case === "callId"
          ? { case: "callId", value: source.value }
          : { case: "approvalToolId", value: source.value },
    });
    const element = frame.current;
    if (!element?.contentWindow) return;
    const targetWindow = element.contentWindow;
    const controller = new AbortController();
    let connection: AppBridge | undefined;
    let rejectOrigin: ((event: MessageEvent) => void) | undefined;
    const load = async () => {
      const response = await consoleClient.getAppResource({ app }, { signal: controller.signal });
      const resource = ReadResourceResultSchema.parse(response.result?.value).contents[0];
      const html =
        "text" in resource
          ? resource.text
          : new TextDecoder().decode(
              Uint8Array.from(atob(resource.blob), (char) => char.charCodeAt(0)),
            );
      const origin = new URL(response.sandboxOrigin).origin;
      const csp = appResourcePolicy(resource._meta?.ui);
      rejectOrigin = (event) => {
        if (event.source === element.contentWindow && event.origin !== origin)
          event.stopImmediatePropagation();
      };
      window.addEventListener("message", rejectOrigin, true);
      const host = new AppBridge(
        null,
        { name: "AgentOS", version: "1.0.0" },
        {
          serverTools: {},
          openLinks: {},
          ...(canMessage ? { message: { text: {} } } : {}),
          sandbox: { csp, permissions: {} },
        },
        { hostContext: currentContext() },
      );
      connection = host;
      bridge.current = host;
      let initialized = false,
        sent = false;
      const publish = () => {
        const value = latest.current;
        if (!initialized || sent || (!value.result && !value.canceled)) return;
        sent = true;
        const sentResult = value.canceled
          ? host.sendToolCancelled({ reason: cancellationReason() })
          : value.result && host.sendToolResult(value.result);
        void sentResult?.catch(() => {});
      };
      deliver.current = publish;
      host.onsandboxready = () => {
        void host.sendSandboxResourceReady({ html, csp }).catch(() => setError(true));
      };
      host.oninitialized = () => {
        void host
          .sendToolInput({
            arguments: latest.current.input.arguments ?? {},
          })
          .then(() => {
            initialized = true;
            publish();
          })
          .catch(() => setError(true));
      };
      host.onsizechange = ({ height }) => {
        if (height && Number.isFinite(height)) setHeight(Math.max(180, Math.min(680, height)));
      };
      host.oncalltool = async (params, extra) => {
        const result = await consoleClient.callAppTool(
          {
            app,
            name: params.name,
            arguments: { value: (params.arguments ?? {}) as JsonObject },
          },
          { signal: AbortSignal.any([controller.signal, extra.mcpReq.signal]) },
        );
        return CallToolResultSchema.parse(result.result?.value);
      };
      host.onopenlink = async ({ url }) => {
        const target = new URL(url);
        if (!["http:", "https:"].includes(target.protocol))
          throw new Error("Unsupported link protocol");
        window.open(target.href, "_blank", "noopener,noreferrer");
        return {};
      };
      host.onmessage = async ({ content }) => {
        if (content.some((part) => part.type !== "text"))
          throw new Error("Only text messages are supported");
        const text = content
          .flatMap((part) => (part.type === "text" ? [part.text] : []))
          .join("\n");
        message(text);
        return {};
      };
      host.onrequestdisplaymode = async ({ mode }) => {
        if (mode === "fullscreen") await container.current?.requestFullscreen();
        else if (mode === "inline" && document.fullscreenElement) await document.exitFullscreen();
        else if (mode !== "inline") throw new Error("Unsupported display mode");
        return { mode };
      };
      await host.connect(new PostMessageTransport(targetWindow, targetWindow));
      if (!controller.signal.aborted) {
        const url = new URL("/mcp-app-sandbox", origin);
        if (csp.resourceDomains?.includes("data:")) url.searchParams.set("data", "1");
        element.src = url.href;
      }
    };
    void load().catch(() => {
      if (!controller.signal.aborted) setError(true);
    });
    return () => {
      controller.abort();
      deliver.current = () => {};
      bridge.current = undefined;
      if (rejectOrigin) window.removeEventListener("message", rejectOrigin, true);
      void connection?.close();
    };
  }, [taskId, source.case, source.value, canMessage]);
  return (
    <div
      ref={container}
      data-testid="mcp-app-view"
      data-call-id={reference.origin.value}
      className="min-w-0 overflow-hidden bg-background"
    >
      <div className="flex items-center justify-between gap-2 border-b px-3 py-1.5 text-xs font-medium">
        <span className="flex items-center gap-2">
          <ToolIcon name={input.tool} server={label.server} className="size-4" />
          {label.name}
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t(fullscreen ? "mcpApp.exitFullscreen" : "mcpApp.fullscreen")}
          onClick={() => {
            void (fullscreen ? document.exitFullscreen() : container.current?.requestFullscreen());
          }}
        >
          {fullscreen ? <Minimize2 /> : <Maximize2 />}
        </Button>
      </div>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{t("mcpApp.unavailable")}</AlertDescription>
        </Alert>
      )}
      <iframe
        ref={frame}
        title={label.name}
        sandbox="allow-scripts allow-same-origin allow-forms"
        referrerPolicy="strict-origin"
        className="block w-full border-0"
        style={{
          height: fullscreen ? "calc(100dvh - 3rem)" : height,
          display: error ? "none" : undefined,
        }}
      />
    </div>
  );
}
