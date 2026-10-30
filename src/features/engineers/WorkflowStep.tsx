import { Handle, type NodeProps, Position } from "@xyflow/react";
import { Bot, GitBranch, Settings, UserRound } from "lucide-react";
import { useTranslation } from "react-i18next";
import { WorkflowNodeKind } from "../../../gen/agentos/console/v1/pack_pb.js";
import { Avatar } from "../shared/Avatar.js";
import { roleLabel } from "../shared/engineers.js";
import { type FlowStage, type FlowStep, workflowStepHeight } from "./workflow-graph.js";

export function WorkflowStep({ data }: NodeProps<FlowStep>) {
  const { t } = useTranslation();
  const { node, title, handles } = data;
  const Icon =
    node.kind === WorkflowNodeKind.HUMAN
      ? UserRound
      : node.kind === WorkflowNodeKind.DECISION
        ? GitBranch
        : node.kind === WorkflowNodeKind.SYSTEM
          ? Settings
          : Bot;
  const label =
    node.kind === WorkflowNodeKind.AGENT
      ? roleLabel(node.role)
      : node.kind === WorkflowNodeKind.HUMAN
        ? t("workflows.human")
        : node.kind === WorkflowNodeKind.DECISION
          ? t("workflows.decision")
          : t("workflows.system");
  return (
    <div className="workflow-step" style={{ height: workflowStepHeight }}>
      {handles.map((handle) => (
        <Handle
          key={handle.id}
          id={handle.id}
          type={handle.type}
          position={handle.position}
          style={
            handle.position === Position.Top || handle.position === Position.Bottom
              ? { left: `${handle.offset}%` }
              : { top: handle.offset }
          }
          isConnectable={false}
        />
      ))}
      <div className="workflow-artwork" aria-hidden>
        {node.kind === WorkflowNodeKind.AGENT ? (
          <Avatar role={node.role} className="h-full w-full" />
        ) : (
          <Icon size={30} strokeWidth={1.6} />
        )}
      </div>
      <span className="workflow-role">{label}</span>
      <strong>{title}</strong>
    </div>
  );
}

export function WorkflowStage({ data }: NodeProps<FlowStage>) {
  return <div className="workflow-stage">{data.title}</div>;
}
