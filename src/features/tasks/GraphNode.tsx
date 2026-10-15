import { Handle, type Node, type NodeProps, Position } from "@xyflow/react";
import { UserRoundCheck } from "lucide-react";
import { memo } from "react";
import { useTranslation } from "react-i18next";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { Engineer } from "../../../gen/agentos/console/v1/engineer_pb.js";
import { ActivityState } from "../../../gen/agentos/console/v1/state_pb.js";
import { type Interaction, InteractionKind } from "../../../gen/agentos/console/v1/task_pb.js";
import { Avatar } from "../shared/Avatar.js";
import { engineerName } from "../shared/engineers.js";
import { awaiting, labelKey, posture } from "../status/activity.js";
import { appearance, StatusIcon } from "../status/Status.js";
import type { ActivityLayout } from "./flow/collaboration-layout.js";

export type AgentNode = Node<
  {
    agent: Engineer;
    activity: ActivityLayout;
    selected: boolean;
    rootState: ActivityState;
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

function nodeState(activity: ActivityLayout, rootState: ActivityState) {
  if (activity.kind === "review" && activity.step)
    return { state: activity.step.link.state, label: labelKey(activity.step.link.state) };
  if (activity.interaction)
    return { state: activity.interaction.state, label: humanLabel(activity.interaction) };
  if (activity.step)
    return { state: activity.step.link.state, label: labelKey(activity.step.link.state) };
  if (activity.root && activity.final) return { state: rootState, label: labelKey(rootState) };
  return {
    state: ActivityState.SUCCEEDED,
    label: activity.kind === "resume" ? "status.summarized" : "status.dispatched",
  };
}

export const AgentCard = memo(function AgentCard({ data }: NodeProps<AgentNode>) {
  const { t } = useTranslation();
  const { activity, agent } = data;
  const human = activity.kind === "approval" ? activity.interaction : undefined;
  const { state, label } = nodeState(activity, data.rootState);
  const name = human
    ? t(human.kind === InteractionKind.APPROVAL ? "approval.title" : "approval.userInput")
    : engineerName(agent);
  return (
    <div
      data-testid={
        human
          ? "approval-node"
          : activity.kind === "execution" || activity.kind === "review"
            ? "collaboration-step"
            : "collaboration-activity"
      }
      data-agent={human ? "human" : agent.id}
      data-column={activity.column}
      data-order={activity.step?.order}
      data-phase={activity.kind}
      data-state={ActivityState[state]}
      className={cn(
        "relative flex h-full flex-col items-center justify-center gap-1 rounded-xl border px-2 py-2 shadow-xs",
        appearance(state).className,
        data.selected && "ring-2 ring-primary/40",
      )}
    >
      <Handle type="target" position={Position.Left} />
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
          <UserRoundCheck className="size-9 stroke-[1.5]" />
        </div>
      ) : (
        <Avatar role={agent.role} state={posture(state)} animated className="h-[68px] w-16" />
      )}
      <strong className="max-w-full truncate text-xs font-semibold text-foreground" title={name}>
        {name}
      </strong>
      <Handle type="source" position={Position.Right} />
    </div>
  );
});
