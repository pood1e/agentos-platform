import { useTranslation } from "react-i18next";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { cn } from "@/lib/utils";
import { ActivityState } from "../../../gen/agentos/execution/v1/state_pb.js";
import type { ToolCall } from "../../../gen/agentos/execution/v1/task_pb.js";
import { duration, millis, pretty, time } from "../../lib/format.js";
import { ToolIcon } from "../shared/ToolIcon.js";
import { useToolText } from "../shared/use-tool-text.js";
import { active } from "../status/activity.js";
import { Status } from "../status/Status.js";
import { callKey } from "./flow/links.js";

export function CallList({ calls, selected = "" }: { calls: ToolCall[]; selected?: string }) {
  const { t } = useTranslation();
  const toolText = useToolText();
  if (!calls.length) return <p className="py-6 text-sm text-muted-foreground">{t("tool.empty")}</p>;
  return (
    <Accordion type="multiple" defaultValue={selected ? [selected] : []}>
      {calls.map((call) => {
        const key = callKey(call.taskId, call.id);
        const label = toolText(call.name);
        const startedAt = millis(call.startedAt);
        return (
          <AccordionItem key={key} value={key} data-testid="drawer-call" data-tool-name={call.name}>
            <AccordionTrigger className="items-start py-4 hover:no-underline">
              <div className="flex min-w-0 flex-1 gap-3 text-left">
                <ToolIcon name={call.name} server={label.server} className="mt-0.5 size-8" />
                <div className="min-w-0 flex-1 space-y-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs">{label.name}</span>
                    <Status state={call.state} />
                  </div>
                  <p
                    data-testid="call-intent"
                    className="text-xs leading-5 font-normal text-muted-foreground"
                  >
                    {call.intent || label.description || t("tool.unreportedIntent")}
                  </p>
                  <p className="text-[10px] font-normal text-muted-foreground">
                    {time(startedAt)} · {duration(startedAt, millis(call.endedAt))}
                  </p>
                </div>
              </div>
            </AccordionTrigger>
            <AccordionContent>
              <CallDetail call={call} />
            </AccordionContent>
          </AccordionItem>
        );
      })}
    </Accordion>
  );
}

function CallDetail({ call }: { call: ToolCall }) {
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
