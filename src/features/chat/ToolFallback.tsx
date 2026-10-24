import type { ToolCallMessagePartComponent } from "@assistant-ui/react";
import { isMessage } from "@bufbuild/protobuf";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { ToolCallSchema } from "../../../gen/agentos/execution/v1/task_pb.js";
import { ToolCallDetails } from "../shared/ToolCallDetails.js";
import { ToolIcon } from "../shared/ToolIcon.js";
import { useToolText } from "../shared/use-tool-text.js";
import { labelKey } from "../status/activity.js";
import { appearance, Status, StatusIcon } from "../status/Status.js";
import { McpApp } from "./apps/McpApp.js";

export const ToolFallback: ToolCallMessagePartComponent = ({ artifact }) => {
  const { t } = useTranslation();
  const toolText = useToolText();
  if (!isMessage(artifact, ToolCallSchema)) return null;
  const call = artifact;
  if (call.uiResourceUri) return <McpApp call={call} />;
  const label = toolText(call.name);
  const title = `${label.name} · ${t(labelKey(call.state))}`;
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button
          data-testid="chat-tool-call"
          data-tool-name={call.name}
          data-call-id={call.id}
          variant="ghost"
          size="icon"
          title={title}
          aria-label={title}
          className="relative size-9 shrink-0 rounded-lg border border-border/60 bg-muted/20"
        >
          <ToolIcon name={call.name} server={label.server} className="size-5" />
          <span
            className="absolute -right-0.5 -bottom-0.5 rounded-full bg-background p-0.5"
            style={{ color: appearance(call.state).color }}
          >
            <StatusIcon state={call.state} className="size-2.5" />
          </span>
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[80dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{label.name}</DialogTitle>
        </DialogHeader>
        <Status state={call.state} />
        <ToolCallDetails call={call} />
      </DialogContent>
    </Dialog>
  );
};
