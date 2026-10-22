import { useTranslation } from "react-i18next";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import type { ToolCall } from "../../../gen/agentos/execution/v1/task_pb.js";
import { duration, millis, time } from "../../lib/format.js";
import { ToolCallDetails } from "../shared/ToolCallDetails.js";
import { ToolIcon } from "../shared/ToolIcon.js";
import { useToolText } from "../shared/use-tool-text.js";
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
              <ToolCallDetails call={call} />
            </AccordionContent>
          </AccordionItem>
        );
      })}
    </Accordion>
  );
}
