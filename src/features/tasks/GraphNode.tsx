import { Handle, type Node, type NodeProps } from "@xyflow/react";
import { UserRoundCheck } from "lucide-react";
import { memo } from "react";
import { useTranslation } from "react-i18next";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { Engineer } from "../../../gen/agentos/console/v1/engineer_pb.js";
import { ActivityState } from "../../../gen/agentos/console/v1/state_pb.js";
import { type Interaction, InteractionKind } from "../../../gen/agentos/console/v1/task_pb.js";
import { Avatar } from "../shared/Avatar.js";
import { ToolIcon } from "../shared/ToolIcon.js";
import { awaiting, labelKey, posture } from "../status/activity.js";
import { appearance, StatusIcon } from "../status/Status.js";
import { currentInteraction } from "./flow/approval-activities.js";
import type { ActivityLayout } from "./flow/collaboration-layout.js";

export type AgentNode = Node<
  {
    agent: Engineer;
    name: string;
    activity: ActivityLayout;
    selected: boolean;
  },
  "agent"
>;

function humanLabel(interaction: Interaction) {
  if (awaiting(interaction.state))
    return interaction.kind === InteractionKind.APPROVAL
      ? "approval.pending"
      : "activity.awaitingInput";
  if (interaction.kind === InteractionKind.QUESTION) return "approval.answered";
  return interaction.state === ActivityState.REJECTED ? "approval.rejected" : "approval.approved";
}

function nodeState(activity: ActivityLayout) {
  const interaction = currentInteraction(activity.interactions);
  if (interaction) return { state: activity.state, label: humanLabel(interaction) };
  const state = activity.state;
  return { state, label: labelKey(state) };
}

export const AgentCard = memo(function AgentCard({ data }: NodeProps<AgentNode>) {
  const { t } = useTranslation();
  const { activity, agent } = data;
  const human = currentInteraction(activity.interactions);
  const { state, label } = nodeState(activity);
  const name = activity.ticket
    ? t("graph.ticket", { id: activity.ticket.ticketId })
    : human
      ? t(human.kind === InteractionKind.APPROVAL ? "approval.title" : "approval.userInput")
      : data.name;
  return (
    <div
      data-testid={human ? "approval-node" : "collaboration-step"}
      data-agent={human ? "human" : agent.id}
      data-instance={human ? undefined : activity.contextId}
      data-ticket={activity.ticket?.ticketId}
      data-environment={activity.ticket?.environment?.name}
      data-row={activity.row}
      data-phase={activity.kind}
      data-state={ActivityState[state]}
      className={cn(
        "relative flex h-full flex-col items-center justify-center gap-1 rounded-xl border px-2 py-2 shadow-xs",
        appearance(state).className,
        data.selected && "ring-2 ring-primary/40",
      )}
    >
      {activity.handles.map((handle) => (
        <Handle
          key={handle.id}
          id={handle.id ?? undefined}
          type={handle.type}
          position={handle.position}
          isConnectable={false}
          style={{ left: handle.x, top: handle.y, right: "auto", bottom: "auto" }}
        />
      ))}
      <Tooltip>
        <TooltipTrigger asChild>
          <span role="img" aria-label={t(label)} className="absolute top-2 right-2">
            <StatusIcon state={state} className="size-3.5" />
          </span>
        </TooltipTrigger>
        <TooltipContent>{t(label)}</TooltipContent>
      </Tooltip>
      {human ? (
        <div className="flex h-[68px] items-center justify-center">
          {activity.ticket ? (
            <ToolIcon
              name={activity.ticket.ticketUrl}
              className="size-12 border-0 bg-transparent [&_img]:size-9"
            />
          ) : (
            <UserRoundCheck className="size-9 stroke-[1.5]" />
          )}
        </div>
      ) : (
        <Avatar role={agent.role} state={posture(state)} animated className="h-[68px] w-16" />
      )}
      <strong className="max-w-full truncate text-xs font-semibold text-foreground" title={name}>
        {name}
      </strong>
    </div>
  );
});
