import { BaseEdge, type EdgeProps, getBezierPath } from "@xyflow/react";
import { type FlowEdge, feedbackBezier, routedBezier } from "./workflow-graph.js";

export function WorkflowEdge(props: EdgeProps<FlowEdge>) {
  const { sourceX, sourceY, targetX, targetY } = props;
  const laneY = props.data?.laneY;
  const feedback = props.data?.feedback;
  const [path, labelX, labelY] = feedback
    ? feedbackBezier(sourceX, sourceY, targetX, targetY, feedback)
    : laneY === undefined
      ? getBezierPath(props)
      : routedBezier(sourceX, sourceY, targetX, targetY, laneY);
  return (
    <BaseEdge
      id={props.id}
      path={path}
      label={props.label}
      labelX={labelX}
      labelY={labelY}
      labelStyle={props.labelStyle}
      labelShowBg={props.labelShowBg}
      labelBgStyle={props.labelBgStyle}
      labelBgPadding={props.labelBgPadding}
      labelBgBorderRadius={props.labelBgBorderRadius}
      markerEnd={props.markerEnd}
      style={props.style}
      interactionWidth={props.interactionWidth}
    />
  );
}
