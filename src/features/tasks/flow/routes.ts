import { getBezierPath, type NodeHandle, Position, type XYPosition } from "@xyflow/react";
import type { ElkNode, ElkPort } from "elkjs/lib/elk-api.js";
import type { ConnectionBundle } from "./connection-bundles.js";

function portSide(port: ElkPort): Position {
  switch (port.layoutOptions?.["elk.port.side"]) {
    case "NORTH":
      return Position.Top;
    case "SOUTH":
      return Position.Bottom;
    case "EAST":
      return Position.Right;
    case "WEST":
      return Position.Left;
    default:
      throw new Error(`Missing port side: ${port.id}`);
  }
}

function endpoint(node: ElkNode, port: ElkPort, side: Position): XYPosition {
  return {
    x:
      (node.x ?? 0) +
      (side === Position.Left ? 0 : side === Position.Right ? (node.width ?? 0) : (port.x ?? 0)),
    y:
      (node.y ?? 0) +
      (side === Position.Top ? 0 : side === Position.Bottom ? (node.height ?? 0) : (port.y ?? 0)),
  };
}

/** As in arch-web, ELK allocates ports and React Flow generates direct Bezier edges. */
export function instanceRoutes(connections: ConnectionBundle[], graph: ElkNode) {
  const nodes = new Map(graph.children?.map((node) => [node.id, node]));
  const handles = new Map<string, NodeHandle[]>();
  const routes = new Map<
    string,
    { path: string; label: XYPosition; sourceHandle: string; targetHandle: string }
  >();
  const attach = (
    node: ElkNode,
    id: string,
    type: NodeHandle["type"],
    side: Position,
    point: XYPosition,
  ) => {
    handles.set(node.id, [
      ...(handles.get(node.id) ?? []),
      {
        id,
        type,
        position: side,
        x: point.x - (node.x ?? 0),
        y: point.y - (node.y ?? 0),
        width: 1,
        height: 1,
      },
    ]);
  };
  for (const edge of connections) {
    const source = nodes.get(edge.source),
      target = nodes.get(edge.target);
    const sourceHandle = `${edge.id}:source`,
      targetHandle = `${edge.id}:target`;
    const sourcePort = source?.ports?.find((port) => port.id === sourceHandle);
    const targetPort = target?.ports?.find((port) => port.id === targetHandle);
    if (!source || !target || !sourcePort || !targetPort) continue;
    const self = source.id === target.id;
    const sourceSide = portSide(sourcePort),
      targetSide = portSide(targetPort);
    const from = endpoint(source, sourcePort, sourceSide),
      to = endpoint(target, targetPort, targetSide);
    const [path, x, y] = getBezierPath({
      sourceX: from.x,
      sourceY: from.y,
      sourcePosition: sourceSide,
      targetX: to.x,
      targetY: to.y,
      targetPosition: targetSide,
      curvature: self ? 0.6 : 0.25,
    });
    attach(source, sourceHandle, "source", sourceSide, from);
    attach(target, targetHandle, "target", targetSide, to);
    routes.set(edge.id, { path, label: { x, y }, sourceHandle, targetHandle });
  }
  return { handles, routes };
}
