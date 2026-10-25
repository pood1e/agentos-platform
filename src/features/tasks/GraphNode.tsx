import { Handle, type Node, type NodeProps } from "@xyflow/react";
import { Blocks, UserRoundCheck } from "lucide-react";
import { memo } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { Engineer } from "../../../gen/agentos/console/v1/engineer_pb.js";
import { InteractionKind } from "../../../gen/agentos/console/v1/task_pb.js";
import { ActivityState } from "../../../gen/agentos/execution/v1/state_pb.js";
import { Avatar } from "../shared/Avatar.js";
import { engineerName } from "../shared/engineers.js";
import { interactionLabel } from "../shared/interaction-state.js";
import { ToolIcon } from "../shared/ToolIcon.js";
import { labelKey, posture } from "../status/activity.js";
import { appearance, StatusIcon } from "../status/Status.js";
import { currentInteraction } from "./flow/approval-activities.js";
import type { ActivityLayout } from "./flow/collaboration-layout.js";

export type AgentNode = Node<
  {
    agent: Engineer;
    agentName: string;
    name: string;
    activity: ActivityLayout;
    selected: boolean;
    onExplore?: () => void;
  },
  "agent"
>;

function nodeState(activity: ActivityLayout) {
  const interaction = currentInteraction(activity.interactions);
  if (interaction) return { state: activity.state, label: interactionLabel(interaction) };
  const state = activity.state;
  return { state, label: labelKey(state) };
}

export const AgentCard = memo(function AgentCard({ data }: NodeProps<AgentNode>) {
  const { t } = useTranslation();
  const { activity, agent } = data;
  const human = currentInteraction(activity.interactions);
  const { state, label } = nodeState(activity);
  const name = activity.record
    ? (activity.record.link?.name ?? t("approval.title"))
    : human
      ? t(human.kind === InteractionKind.APPROVAL ? "approval.title" : "approval.userInput")
      : data.name;
  return (
    <div
      data-testid={human ? "approval-node" : "collaboration-step"}
      data-agent={human ? "human" : agent.id}
      data-instance={human ? undefined : activity.contextId}
      data-record={activity.record?.id}
      data-row={activity.row}
      data-phase={activity.kind}
      data-state={ActivityState[state]}
      className={cn(
        "relative flex h-full flex-col justify-center rounded-xl border bg-card p-3 shadow-sm",
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
      <div className="flex min-w-0 items-center gap-3">
        {human ? (
          <div className="flex size-10 shrink-0 items-center justify-center">
            {activity.record ? (
              <ToolIcon
                name={activity.record.link?.url ?? ""}
                className="size-9 border-0 bg-transparent [&_img]:size-6"
              />
            ) : (
              <UserRoundCheck className="size-7 stroke-[1.5]" />
            )}
          </div>
        ) : (
          <Avatar role={agent.role} state={posture(state)} animated className="h-10 w-9 shrink-0" />
        )}
        <div className="min-w-0 flex-1">
          <strong
            className="block max-w-full truncate text-sm font-semibold text-foreground"
            title={name}
          >
            {human ? name : data.agentName}
          </strong>
          {!human && name !== engineerName(agent) && (
            <span className="block truncate text-[10px]" title={name}>
              {name}
            </span>
          )}
          <span className="mt-1 block text-[10px]">{t(label)}</span>
        </div>
      </div>
      {!human && data.onExplore && (
        <div className="mt-1 flex justify-end">
          <Button
            variant="ghost"
            size="xs"
            className="h-6 gap-1 text-[10px]"
            onClick={(event) => {
              event.stopPropagation();
              data.onExplore?.();
            }}
          >
            <Blocks className="size-3" />
            {t("graph.mcpCalls")}
          </Button>
        </div>
      )}
    </div>
  );
});
