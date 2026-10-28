import { create, type JsonObject } from "@bufbuild/protobuf";
import type { CallToolResult } from "@modelcontextprotocol/client";
import { CallToolResultSchema } from "@modelcontextprotocol/core";
import type { AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge";
import { Maximize2, Minimize2, RotateCw } from "lucide-react";
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
import { mountMcpApp } from "../../../../shared/browser/mcp-app-host.js";
import { consoleClient } from "../../../lib/console.js";
import { ToolIcon } from "../../shared/ToolIcon.js";
import { useToolText } from "../../shared/use-tool-text.js";
import { hostContext } from "./host-context.js";
import { useAppResource } from "./use-app-resource.js";

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
  const callId = reference.callId;
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
  const [ready, setReady] = useState(false);
  const resource = useAppResource(reference);
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
    setError(false);
    setReady(false);
    if (!callId || !resource.data || !resource.dataUpdatedAt || resource.isError) return;
    const app = create(AppReferenceSchema, {
      taskId,
      callId,
    });
    const element = frame.current;
    if (!element) return;
    const controller = new AbortController();
    try {
      const host = mountMcpApp({
        frame: element,
        resource: resource.data.result?.value,
        sandboxOrigin: resource.data.sandboxOrigin,
        context: currentContext(),
        signal: controller.signal,
        snapshot: () => ({
          ...latest.current,
          input: { arguments: latest.current.input.arguments ?? {} },
        }),
        cancellationReason,
        onReady: () => setReady(true),
        onError: () => setError(true),
        onSizeChange: setHeight,
        onMessage: canMessage ? message : undefined,
        onCallTool: async (params, extra) => {
          const result = await consoleClient.callAppTool(
            {
              app,
              name: params.name,
              arguments: { value: (params.arguments ?? {}) as JsonObject },
            },
            {
              signal: AbortSignal.any([controller.signal, extra.mcpReq.signal]),
              timeoutMs: 20_000,
            },
          );
          return CallToolResultSchema.parse(result.result?.value);
        },
        onDisplayMode: async ({ mode }) => {
          if (mode === "fullscreen") await container.current?.requestFullscreen();
          else if (mode === "inline" && document.fullscreenElement) await document.exitFullscreen();
          else if (mode !== "inline") throw new Error("Unsupported display mode");
          return { mode };
        },
      });
      bridge.current = host.bridge;
      deliver.current = host.publish;
    } catch {
      setError(true);
    }
    return () => {
      controller.abort();
      deliver.current = () => {};
      bridge.current = undefined;
    };
  }, [taskId, callId, canMessage, resource.data, resource.dataUpdatedAt, resource.isError]);
  const failed = error || resource.isError;
  return (
    <div
      ref={container}
      data-testid="mcp-app-view"
      data-call-id={reference.callId}
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
      {failed && (
        <Alert variant="destructive">
          <AlertDescription className="flex items-center justify-between gap-2">
            {t("mcpApp.unavailable")}
            <Button
              variant="outline"
              size="sm"
              disabled={resource.isFetching}
              onClick={() => {
                setError(false);
                setReady(false);
                void resource.refetch();
              }}
            >
              <RotateCw />
              {t("common.retry")}
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {!failed && !ready && (
        <div
          role="status"
          className="h-48 animate-pulse bg-muted"
          aria-label={t("common.loading")}
        />
      )}
      <iframe
        ref={frame}
        title={label.name}
        sandbox="allow-scripts allow-same-origin allow-forms"
        referrerPolicy="strict-origin"
        className="block w-full border-0"
        style={{
          height: fullscreen ? "calc(100dvh - 3rem)" : height,
          display: failed ? "none" : undefined,
          visibility: ready ? "visible" : "hidden",
          position: ready ? undefined : "absolute",
        }}
      />
    </div>
  );
}
