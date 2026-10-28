import { useAui } from "@assistant-ui/react";
import { create, toJson } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import { ChevronDown } from "lucide-react";
import { lazy, Suspense, useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ActivityState } from "../../../../gen/agentos/execution/v1/state_pb.js";
import type { ToolCall } from "../../../../gen/agentos/execution/v1/task_pb.js";
import { AppReferenceSchema, AppViewSchema } from "../../../../gen/agentos/mcp/v1/app_pb.js";
import { ToolIcon } from "../../shared/ToolIcon.js";
import { useToolText } from "../../shared/use-tool-text.js";
import { active, awaiting } from "../../status/activity.js";
import { Status } from "../../status/Status.js";
import { appResult } from "./result.js";

const View = lazy(() => import("./AppView.js").then((module) => ({ default: module.AppView })));
export function McpApp({ call }: { call: ToolCall }) {
  const { t } = useTranslation();
  const label = useToolText()(call.name);
  const aui = useAui();
  const onMessage = useCallback(
    (text: string) => {
      const composer = aui.thread().composer();
      composer.setText([composer.getState().text, text].filter(Boolean).join("\n"));
    },
    [aui],
  );
  const args = call.args ? toJson(ValueSchema, call.args) : {};
  const input = create(AppViewSchema, {
    tool: call.name,
    arguments: args && typeof args === "object" && !Array.isArray(args) ? args : {},
  });
  const reference = create(AppReferenceSchema, {
    taskId: call.taskId,
    callId: call.id,
  });
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen} asChild>
      <Card
        data-testid="mcp-app"
        data-call-id={call.id}
        className="my-3 min-w-0 gap-0 overflow-hidden py-0 shadow-none"
      >
        <CollapsibleTrigger asChild>
          <Button
            variant="ghost"
            aria-label={t(open ? "mcpApp.collapse" : "mcpApp.expand")}
            className="h-auto w-full justify-between rounded-none px-3 py-2"
          >
            <span className="flex min-w-0 items-center gap-2 text-xs">
              <ToolIcon name={call.name} server={label.server} className="size-4" />
              <span className="truncate">{label.name}</span>
              <Status state={call.state} />
            </span>
            <ChevronDown className={open ? "size-4 rotate-180" : "size-4"} />
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <Suspense fallback={<div className="h-48 animate-pulse bg-muted" />}>
            <View
              reference={reference}
              input={input}
              result={active(call.state) || awaiting(call.state) ? undefined : appResult(call)}
              canceled={call.state === ActivityState.CANCELED}
              onMessage={onMessage}
            />
          </Suspense>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );
}
