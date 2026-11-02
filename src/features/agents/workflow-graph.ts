import { type Edge, MarkerType, type Node, Position, type Rect } from "@xyflow/react";
import {
  type CollaborationWorkflow,
  WorkflowInteraction,
  type WorkflowNode,
} from "../../../gen/agentos/console/v1/pack_pb.js";

export type FlowHandle = {
  id: string;
  position: Position;
  type: "source" | "target";
  offset: number;
};
export type FlowStep = Node<{ node: WorkflowNode; title: string; handles: FlowHandle[] }, "step">;
export type FlowStage = Node<{ title: string }, "stage">;
type FlowNode = FlowStep | FlowStage;
type FeedbackLane = { x: number; y: number };
export type FlowEdge = Edge<{ laneY?: number; feedback?: FeedbackLane }, "workflow">;

export function feedbackBezier(
  sx: number,
  sy: number,
  tx: number,
  ty: number,
  lane: FeedbackLane,
): [string, number, number] {
  const { x, y } = lane;
  return [
    `M ${sx} ${sy} C ${sx} ${y} ${sx} ${y} ${x + 24} ${y}
      C ${x} ${y} ${x} ${y} ${x} ${y - 24}
      C ${x} ${y - 24} ${x} ${ty + 24} ${x} ${ty + 24}
      C ${x} ${ty} ${x} ${ty} ${tx} ${ty}`,
    (sx + x) / 2,
    y,
  ];
}

export function routedBezier(
  sourceX: number,
  sourceY: number,
  targetX: number,
  targetY: number,
  laneY: number,
): [string, number, number] {
  return [
    `M ${sourceX} ${sourceY} C ${sourceX} ${laneY} ${targetX} ${laneY} ${targetX} ${targetY}`,
    (sourceX + targetX) / 2,
    (sourceY + 6 * laneY + targetY) / 8,
  ];
}

type Workflow = CollaborationWorkflow;
type End = {
  node: string;
  other: Workflow["nodes"][number];
  position: Position;
  type: "source" | "target";
  id: string;
};
const columnSpacing = 180;
const rowSpacing = 270;
export const workflowStepHeight = 150;
const lanePadding = 12;
const stageClearance = 30;

export function workflowGraph(workflow: Workflow, translate: (key: string) => string) {
  const nodeById = new Map(workflow.nodes.map((node) => [node.id, node]));
  const ends: End[] = [];
  const feedback = new Map<string, FeedbackLane>();
  const lastRow = Math.max(...workflow.nodes.map((node) => node.row));
  const routes = workflow.edges.map((edge, index) => {
    const source = nodeById.get(edge.source);
    const target = nodeById.get(edge.target);
    if (!source || !target) throw new Error("Workflow edge references a missing node");
    const dx = target.column - source.column;
    const dy = target.row - source.row;
    const isFeedback = dy < -1;
    const side = dy === 0 && Math.abs(dx) > 1 ? Position.Bottom : undefined;
    const sourcePosition =
      (isFeedback ? Position.Bottom : side) ??
      (dy ? (dy > 0 ? Position.Bottom : Position.Top) : dx > 0 ? Position.Right : Position.Left);
    const targetPosition =
      (isFeedback ? Position.Left : side) ??
      (dy ? (dy > 0 ? Position.Top : Position.Bottom) : dx > 0 ? Position.Left : Position.Right);
    const id = `${edge.source}-${edge.target}-${index}`;
    if (isFeedback)
      feedback.set(id, {
        x: -60 - feedback.size * 24,
        y: lastRow * rowSpacing + workflowStepHeight + 45 + feedback.size * 24,
      });
    const sourceHandle = `${id}-source`;
    const targetHandle = `${id}-target`;
    ends.push({
      node: source.id,
      other: target,
      position: sourcePosition,
      type: "source",
      id: sourceHandle,
    });
    ends.push({
      node: target.id,
      other: source,
      position: targetPosition,
      type: "target",
      id: targetHandle,
    });
    const band = isFeedback
      ? undefined
      : side
        ? source.row
        : dy
          ? Math.min(source.row, target.row)
          : undefined;
    return { edge, source, target, id, sourceHandle, targetHandle, band };
  });
  const bands = new Map<number, typeof routes>();
  for (const route of routes) {
    if (route.band === undefined) continue;
    const group = bands.get(route.band) ?? [];
    group.push(route);
    bands.set(route.band, group);
  }
  const laneY = new Map<string, number>();
  for (const [band, group] of bands) {
    // Keep same-row arcs near their nodes and cross-row handoffs farther away.
    group.sort(
      (a, b) =>
        Number(a.source.row !== a.target.row) - Number(b.source.row !== b.target.row) ||
        Math.abs(a.source.column - a.target.column) - Math.abs(b.source.column - b.target.column),
    );
    group.forEach((route, index) => {
      const start = band * rowSpacing + workflowStepHeight + lanePadding;
      const end = (band + 1) * rowSpacing - stageClearance;
      laneY.set(route.id, start + ((index + 1) * (end - start)) / (group.length + 1));
    });
  }
  const handleGroups = new Map<string, End[]>();
  for (const end of ends) {
    const key = `${end.node}:${end.position}`;
    const group = handleGroups.get(key) ?? [];
    group.push(end);
    handleGroups.set(key, group);
  }
  const handles = new Map<string, FlowHandle[]>();
  for (const group of handleGroups.values()) {
    const row = nodeById.get(group[0].node)?.row;
    group.sort(
      (a, b) =>
        Number(a.other.row !== row) - Number(b.other.row !== row) ||
        a.other.column - b.other.column ||
        a.other.row - b.other.row ||
        a.id.localeCompare(b.id),
    );
    group.forEach((end, index) => {
      const offset =
        end.position === Position.Left || end.position === Position.Right
          ? 42 + (index - (group.length - 1) / 2) * 14
          : ((index + 1) * 100) / (group.length + 1);
      const list = handles.get(end.node) ?? [];
      list.push({ id: end.id, position: end.position, type: end.type, offset });
      handles.set(end.node, list);
    });
  }
  const nodes: FlowNode[] = [
    ...workflow.stages.map(
      (stage): FlowStage => ({
        id: `stage-${stage.row}`,
        type: "stage",
        position: { x: 0, y: stage.row * rowSpacing - 34 },
        data: { title: translate(stage.title) },
        selectable: false,
        draggable: false,
        focusable: false,
      }),
    ),
    ...workflow.nodes.map(
      (node): FlowStep => ({
        id: node.id,
        type: "step",
        position: { x: node.column * columnSpacing, y: node.row * rowSpacing },
        data: { node, title: translate(node.title), handles: handles.get(node.id) ?? [] },
      }),
    ),
  ];
  const edges: FlowEdge[] = routes.map(({ edge, id, sourceHandle, targetHandle }) => ({
    id,
    source: edge.source,
    target: edge.target,
    sourceHandle,
    targetHandle,
    type: "workflow",
    data: { laneY: laneY.get(id), feedback: feedback.get(id) },
    label: edge.label ? translate(edge.label) : undefined,
    style: edge.interaction === WorkflowInteraction.ASYNC ? { strokeDasharray: "6 4" } : undefined,
    markerEnd: { type: MarkerType.ArrowClosed },
  }));
  const feedbackLanes = [...feedback.values()];
  const left = Math.min(0, ...feedbackLanes.map((lane) => lane.x)) - 20;
  const bounds: Rect | undefined = feedbackLanes.length
    ? {
        x: left,
        y: -34,
        width: Math.max(...workflow.nodes.map((node) => node.column)) * columnSpacing + 120 - left,
        height: Math.max(...feedbackLanes.map((lane) => lane.y)) + 54,
      }
    : undefined;
  return { nodes, edges, bounds };
}
