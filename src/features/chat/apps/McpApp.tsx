import { ChevronDown } from "lucide-react";
import { lazy, Suspense, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import type { ToolCall } from "../../../../gen/agentos/execution/v1/task_pb.js";
import { ToolIcon } from "../../shared/ToolIcon.js";
import { useToolText } from "../../shared/use-tool-text.js";
import { Status } from "../../status/Status.js";

const View = lazy(() => import("./AppView.js").then((module) => ({ default: module.AppView })));
export function McpApp({ call }: { call: ToolCall }) {
  const { t } = useTranslation();
  const label = useToolText()(call.name);
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
            <View call={call} />
          </Suspense>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );
}
