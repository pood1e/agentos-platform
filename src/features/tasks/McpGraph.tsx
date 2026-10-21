import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
  Background,
  BackgroundVariant,
  Controls,
  type Edge,
  MarkerType,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useStore,
} from "@xyflow/react";
import type { ElkNode } from "elkjs/lib/elk-api.js";
import { useTheme } from "next-themes";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import type { Engineer } from "../../../gen/agentos/console/v1/engineer_pb.js";
import type { TaskRun } from "../../../gen/agentos/execution/v1/task_pb.js";
import { engineerName } from "../shared/engineers.js";
import { toolServerLabel } from "../shared/tool-label.js";
import { useToolText } from "../shared/use-tool-text.js";
import { appearance } from "../status/Status.js";
import type { DrawerTarget } from "./AgentDrawer.js";
import { elk } from "./flow/elk.js";
import { callKey, running } from "./flow/links.js";
import { mcpCalls } from "./flow/mcp-calls.js";
import { type McpGraphNode, McpNode } from "./McpGraphNode.js";

const nodeTypes = { execution: McpNode };
const proOptions = { hideAttribution: true };

interface Props {
  run: TaskRun;
  engineer?: Engineer;
  selected?: string;
  onInspect: (target: DrawerTarget) => void;
}

function Canvas({ run, engineer, selected, onInspect }: Props) {
  const { t } = useTranslation();
  const toolText = useToolText();
  const { resolvedTheme } = useTheme();
  const canvasWidth = useStore((state) => state.width);
  const canvasHeight = useStore((state) => state.height);
  const vertical = canvasWidth < 640;
  const width = vertical ? 124 : 236;
  const fitPadding = vertical ? 0.05 : 0.18;
  const height = vertical ? 126 : 106;
  const groups = mcpCalls(run.calls, (name) => toolText(name).server);
  const structure: ElkNode = {
    id: "tools",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": vertical ? "DOWN" : "RIGHT",
      "elk.layered.spacing.nodeNodeBetweenLayers": "80",
      "elk.spacing.nodeNode": "24",
      "elk.layered.crossingMinimization.forceNodeModelOrder": "true",
    },
    children: ["agent", ...groups.map((group) => group.id)].map((id) => ({ id, width, height })),
    edges: groups.map((group) => ({
      id: `call:${group.id}`,
      sources: ["agent"],
      targets: [group.id],
    })),
  };
  const key = JSON.stringify(structure);
  const positions = useQuery({
    queryKey: ["mcp-layout", key],
    queryFn: async () => (await elk).layout(structure),
    staleTime: Infinity,
    placeholderData: keepPreviousData,
  });
  const nodes: McpGraphNode[] = (positions.data?.children ?? []).flatMap((position) => {
    const group = groups.find((item) => item.id === position.id);
    if (position.id !== "agent" && !group) return [];
    const title = group
      ? toolServerLabel(group.server)
      : engineer
        ? engineerName(engineer)
        : t("automation.agent");
    return [
      {
        id: position.id,
        type: "execution",
        position: { x: position.x ?? 0, y: position.y ?? 0 },
        width,
        height,
        ariaLabel: title,
        data: {
          kind: group ? "server" : "agent",
          title,
          subtitle: group
            ? t("graph.callCount", { count: group.calls.length })
            : t("graph.executingAgent"),
          state: group?.state ?? run.state,
          server: group?.server,
          iconName: group?.calls[0]?.name,
          selected: !!group && selected === group.server,
          vertical,
        },
      },
    ];
  });
  const edges: Edge[] = (structure.edges ?? []).map((edge) => {
    const group = groups.find((item) => item.id === edge.targets[0]);
    const color = group ? appearance(group.state).color : "var(--graph-return)";
    return {
      id: edge.id,
      source: edge.sources[0] ?? "",
      target: edge.targets[0] ?? "",
      type: "default",
      animated: !!group && running(group.state),
      markerEnd: { type: MarkerType.ArrowClosed, color },
      style: { stroke: color, strokeWidth: 1.5 },
    };
  });
  const { fitView } = useReactFlow();
  const layoutKey = positions.isPlaceholderData ? "" : positions.data ? key : "";
  useEffect(() => {
    if (!layoutKey || !canvasWidth || !canvasHeight) return;
    const frame = requestAnimationFrame(() => void fitView({ padding: fitPadding, maxZoom: 1.1 }));
    return () => cancelAnimationFrame(frame);
  }, [fitView, layoutKey, canvasWidth, canvasHeight, fitPadding]);
  return (
    <ReactFlow<McpGraphNode>
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      colorMode={resolvedTheme === "dark" ? "dark" : "light"}
      minZoom={0.05}
      maxZoom={2}
      nodesConnectable={false}
      nodesDraggable={false}
      proOptions={proOptions}
      ariaLabelConfig={{
        "controls.zoomIn.ariaLabel": t("graph.zoomIn"),
        "controls.zoomOut.ariaLabel": t("graph.zoomOut"),
        "controls.fitView.ariaLabel": t("graph.fit"),
      }}
      onNodeClick={(_event, node) => {
        const group = groups.find((item) => item.id === node.id);
        const call = group?.calls.at(-1);
        onInspect({
          taskId: run.taskId,
          contextId: run.contextId,
          mcpServer: group?.server,
          callKey: call ? callKey(call.taskId, call.id) : undefined,
        });
      }}
    >
      <Background variant={BackgroundVariant.Dots} color="var(--graph-grid)" gap={22} size={1} />
      {!groups.length && (
        <Panel position="bottom-left">
          <p className="max-w-56 text-xs text-muted-foreground">{t("graph.noMcpCalls")}</p>
        </Panel>
      )}
      <Controls
        showInteractive={false}
        position="bottom-right"
        fitViewOptions={{ padding: fitPadding, maxZoom: 1.1 }}
      />
    </ReactFlow>
  );
}

export function McpGraph(props: Props) {
  return (
    <ReactFlowProvider>
      <Canvas {...props} />
    </ReactFlowProvider>
  );
}
