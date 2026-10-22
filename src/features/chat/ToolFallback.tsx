import type { ToolCallMessagePartComponent } from "@assistant-ui/react";
import { isMessage } from "@bufbuild/protobuf";
import { ChevronDown } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ToolCallSchema } from "../../../gen/agentos/execution/v1/task_pb.js";
import { ToolCallDetails } from "../shared/ToolCallDetails.js";
import { ToolIcon } from "../shared/ToolIcon.js";
import { useToolText } from "../shared/use-tool-text.js";
import { Status } from "../status/Status.js";

export const ToolFallback: ToolCallMessagePartComponent = ({ artifact }) => {
  const toolText = useToolText();
  if (!isMessage(artifact, ToolCallSchema)) return null;
  const call = artifact;
  const label = toolText(call.name);
  return (
    <Collapsible
      data-testid="chat-tool-call"
      data-tool-name={call.name}
      data-call-id={call.id}
      className="my-2 rounded-xl border bg-muted/20 text-sm"
    >
      <CollapsibleTrigger className="group flex w-full min-w-0 items-center gap-2 p-3 text-left">
        <ToolIcon name={call.name} server={label.server} className="size-6 shrink-0" />
        <span className="min-w-0 flex-1 truncate text-xs" title={call.name}>
          {label.name}
        </span>
        <Status state={call.state} />
        <ChevronDown className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
      </CollapsibleTrigger>
      <CollapsibleContent className="px-3 pb-3">
        <ToolCallDetails call={call} />
      </CollapsibleContent>
    </Collapsible>
  );
};
