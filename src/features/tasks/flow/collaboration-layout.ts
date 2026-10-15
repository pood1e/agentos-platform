import { graphStratify, layeringLongestPath, sugiyama } from "d3-dag";
import type { CollaborationFlow } from "./collaboration-flow.js";

export const activityWidth = 152;
export const activityHeight = 112;
const rowGap = 36;

export function collaborationLayout(flow: CollaborationFlow) {
  const dependencies = [...flow.connections, ...flow.constraints];
  const graph = graphStratify()(
    flow.activities.map((activity) => ({
      ...activity,
      parentIds: [
        ...new Set(
          dependencies.filter((edge) => edge.target === activity.id).map((edge) => edge.source),
        ),
      ],
    })),
  );
  if (flow.activities.length)
    sugiyama()
      .layering(layeringLongestPath().topDown(true))
      .nodeSize([activityHeight, activityWidth])
      .gap([rowGap, 104])(graph);
  const graphNodes = [...graph.nodes()];
  const coordinates = [...new Set(graphNodes.map((node) => node.y))].sort((a, b) => a - b);
  const columns = coordinates.map((coordinate) =>
    graphNodes.filter((node) => node.y === coordinate).sort((a, b) => a.x - b.x),
  );
  const rows = Math.max(0, ...columns.map((column) => column.length));
  const positions = new Map(
    columns.flatMap((column, index) =>
      column.map(
        (node, row) =>
          [
            node.data.id,
            {
              column: index + 1,
              x: node.y - activityWidth / 2,
              y: ((rows - column.length) / 2 + row) * (activityHeight + rowGap),
            },
          ] as const,
      ),
    ),
  );
  const activities = flow.activities.flatMap((activity) => {
    const position = positions.get(activity.id);
    return position ? [{ ...activity, ...position }] : [];
  });
  return {
    key: JSON.stringify([
      flow.activities.map(({ id }) => id),
      dependencies.map(({ source, target }) => [source, target]),
    ]),
    activities,
    connections: flow.connections,
    steps: flow.steps,
  };
}

export type CollaborationLayout = ReturnType<typeof collaborationLayout>;
export type ActivityLayout = CollaborationLayout["activities"][number];
