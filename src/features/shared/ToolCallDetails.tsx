import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { ActivityState } from "../../../gen/agentos/execution/v1/state_pb.js";
import type { ToolCall } from "../../../gen/agentos/execution/v1/task_pb.js";
import { pretty } from "../../lib/format.js";
import { active } from "../status/activity.js";

export function ToolCallDetails({ call }: { call: ToolCall }) {
  const { t } = useTranslation();
  const output = pretty(call.output);
  return (
    <section className="space-y-4 pb-1" aria-label={t("tool.details")}>
      <code className="block break-all text-[11px] text-muted-foreground">{call.name}</code>
      <div>
        <h4 className="mb-2 text-xs font-medium">{t("tool.arguments")}</h4>
        <pre
          data-testid="call-input"
          className="max-h-72 overflow-auto rounded-lg border bg-muted/40 p-3 font-mono text-[11px] leading-5 whitespace-pre-wrap break-all"
        >
          {pretty(call.args) ?? t("tool.missingArguments")}
        </pre>
      </div>
      <div>
        <h4 className="mb-2 text-xs font-medium">{t("tool.result")}</h4>
        <pre
          data-testid="call-output"
          className={cn(
            "max-h-80 overflow-auto rounded-lg border bg-muted/40 p-3 font-mono text-[11px] leading-5 whitespace-pre-wrap break-all",
            call.state === ActivityState.FAILED &&
              "border-destructive/30 bg-destructive/10 text-destructive",
          )}
        >
          {output ?? t(active(call.state) ? "tool.awaitingResult" : "tool.missingResult")}
        </pre>
      </div>
      <p className="break-all font-mono text-[10px] text-muted-foreground">
        {call.taskId} · {call.id}
      </p>
    </section>
  );
}
