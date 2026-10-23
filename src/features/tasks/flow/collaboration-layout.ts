import { getNodesBounds } from "@xyflow/react";
import type { ElkNode, ElkPort } from "elkjs/lib/elk-api.js";
import type { CollaborationFlow } from "./collaboration-flow.js";
import { bundleConnections } from "./connection-bundles.js";
import { elk } from "./elk.js";
import { instanceRoutes } from "./routes.js";

export const activityWidth = 208;
export const activityHeight = 104;

function layoutGraph(flow: CollaborationFlow): ElkNode {
  const connections = bundleConnections(flow.connections);
  const ranks = new Map(flow.activities.map((activity) => [activity.id, activity.rank]));
  const ports = new Map<string, ElkPort[]>();
  const attach = (id: string, portId: string, side: string) =>
    ports.set(id, [
      ...(ports.get(id) ?? []),
      { id: portId, width: 0, height: 0, layoutOptions: { "elk.port.side": side } },
    ]);
  for (const edge of connections.sort((a, b) => a.id.localeCompare(b.id))) {
    const self = edge.source === edge.target;
    const backward = (ranks.get(edge.target) ?? 0) < (ranks.get(edge.source) ?? 0);
    const sameRow = ranks.get(edge.source) === ranks.get(edge.target);
    attach(
      edge.source,
      `${edge.id}:source`,
      self || sameRow ? "EAST" : backward ? "NORTH" : "SOUTH",
    );
    attach(
      edge.target,
      `${edge.id}:target`,
      self ? "NORTH" : sameRow ? "WEST" : backward ? "SOUTH" : "NORTH",
    );
  }
  return {
    id: "collaboration",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "DOWN",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.partitioning.activate": "true",
      "elk.layered.layering.strategy": "INTERACTIVE",
      "elk.layered.cycleBreaking.strategy": "INTERACTIVE",
      "elk.layered.nodePlacement.strategy": "SIMPLE",
      "elk.spacing.nodeNode": "36",
      "elk.spacing.edgeNode": "28",
      "elk.layered.spacing.nodeNodeBetweenLayers": "80",
      "elk.layered.spacing.edgeNodeBetweenLayers": "28",
      "elk.layered.nodePlacement.bk.fixedAlignment": "BALANCED",
      "elk.randomSeed": "1",
    },
    children: [...flow.activities]
      .sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id))
      .map((activity) => ({
        id: activity.id,
        width: activityWidth,
        height: activityHeight,
        x: 0,
        y: activity.rank * (activityHeight + 80),
        layoutOptions: {
          "elk.partitioning.partition": String(activity.rank),
          "elk.portConstraints": "FIXED_SIDE",
        },
        ports: ports.get(activity.id),
      })),
    edges: connections.map((connection) => ({
      id: connection.id,
      sources: [`${connection.id}:source`],
      targets: [`${connection.id}:target`],
      labels: [{ width: 124, height: 20 }],
    })),
  };
}

export const topologyKey = (flow: CollaborationFlow) => JSON.stringify(layoutGraph(flow));

export async function collaborationPositions(flow: CollaborationFlow) {
  return (await elk).layout(layoutGraph(flow));
}

export function projectLayout(flow: CollaborationFlow, graph: ElkNode) {
  const connections = bundleConnections(flow.connections);
  const positions = new Map(graph.children?.map((node) => [node.id, node]));
  const { handles, routes } = instanceRoutes(connections, graph);
  return {
    key: topologyKey(flow),
    bounds: getNodesBounds(
      (graph.children ?? []).map((node) => ({
        id: node.id,
        position: { x: node.x ?? 0, y: node.y ?? 0 },
        width: node.width,
        height: node.height,
        data: {},
      })),
    ),
    activities: flow.activities.flatMap((activity) => {
      const node = positions.get(activity.id);
      return node
        ? [
            {
              ...activity,
              row: activity.rank + 1,
              x: node.x ?? 0,
              y: node.y ?? 0,
              handles: handles.get(activity.id) ?? [],
            },
          ]
        : [];
    }),
    connections: connections.flatMap((connection) => {
      const route = routes.get(connection.id);
      return route ? [{ ...connection, route }] : [];
    }),
  };
}

export async function collaborationLayout(flow: CollaborationFlow) {
  return projectLayout(flow, await collaborationPositions(flow));
}

type CollaborationLayout = Awaited<ReturnType<typeof collaborationLayout>>;
export type ActivityLayout = CollaborationLayout["activities"][number];
