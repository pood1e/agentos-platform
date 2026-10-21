import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
  Background,
  BackgroundVariant,
  ControlButton,
  Controls,
  MarkerType,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useStore,
} from "@xyflow/react";
import { Maximize2 } from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { Engineer } from "../../../gen/agentos/console/v1/engineer_pb.js";
import { InteractionKind } from "../../../gen/agentos/console/v1/task_pb.js";
import { ActivityState } from "../../../gen/agentos/execution/v1/state_pb.js";
import { engineerName } from "../shared/engineers.js";
import { appearance } from "../status/Status.js";
import { currentInteraction } from "./flow/approval-activities.js";
import type { CollaborationFlow, FlowActivity, FlowConnection } from "./flow/collaboration-flow.js";
import {
  activityHeight,
  activityWidth,
  collaborationPositions,
  projectLayout,
  topologyKey,
} from "./flow/collaboration-layout.js";
import { type ConnectionBundle, connectionSteps, currentStep } from "./flow/connection-bundles.js";
import { instanceNames } from "./flow/instance-names.js";
import { type Link, running } from "./flow/links.js";
import { diagramBounds, graphViewport, zoomLimits } from "./flow/viewport.js";
import { type CollaborationEdge, GraphEdge } from "./GraphEdge.js";
import { AgentCard, type AgentNode } from "./GraphNode.js";

const nodeTypes = { agent: AgentCard };
const edgeTypes = { collaboration: GraphEdge };
const proOptions = { hideAttribution: true };

export interface GraphProps {
  participants: Engineer[];
  flow: CollaborationFlow;
  selected: string;
  selectedConnection: string;
  onSelect: (activity: FlowActivity) => void;
  onExplore?: (activity: FlowActivity) => void;
  onConnection: (connection: ConnectionBundle) => void;
}

const kindLabels: Record<Link["kind"], string> = {
  invoke: "graph.delegate",
  background: "graph.backgroundDispatch",
  handoff: "graph.transfer",
  resume: "graph.continue",
  approval: "graph.requestApproval",
  review: "graph.review",
};

function edgeLabel(connection: FlowConnection, source?: FlowActivity, target?: FlowActivity) {
  const { link } = connection.step;
  if (connection.phase === "return") {
    if (link.kind !== "approval") return "graph.return";
    if (source && currentInteraction(source.interactions)?.kind === InteractionKind.QUESTION)
      return "approval.answered";
    return link.state === ActivityState.REJECTED ? "approval.rejected" : "approval.approved";
  }
  if (connection.phase === "approval") {
    return target && currentInteraction(target.interactions)?.kind === InteractionKind.QUESTION
      ? "graph.requestInput"
      : "graph.requestApproval";
  }
  return kindLabels[link.kind];
}

function Canvas(props: GraphProps) {
  const { participants, flow, selected, selectedConnection } = props;
  const { t } = useTranslation();
  const { resolvedTheme } = useTheme();
  const names = instanceNames(flow.activities, participants);
  const key = topologyKey(flow);
  const positions = useQuery({
    queryKey: ["collaboration-layout", key],
    queryFn: () => collaborationPositions(flow),
    staleTime: Infinity,
    placeholderData: keepPreviousData,
  });
  const layout = useMemo(
    () =>
      positions.data
        ? projectLayout(flow, positions.data)
        : { key: "", bounds: { x: 0, y: 0, width: 0, height: 0 }, activities: [], connections: [] },
    [flow, positions.data],
  );
  const { setViewport, getZoom, viewportInitialized } = useReactFlow<AgentNode>();
  const width = useStore((state) => state.width);
  const height = useStore((state) => state.height);
  const view = useRef({ key: "", manual: false });
  const canvas = useRef<HTMLDivElement>(null);
  const manualView = () => {
    view.current.manual = true;
  };
  const nodes: AgentNode[] = useMemo(
    () =>
      layout.activities.flatMap((activity): AgentNode[] => {
        const agent = participants.find((item) => item.id === activity.agentId);
        if (!agent) return [];
        const peers = layout.activities
          .filter((item) => item.kind === "engineer" && item.agentId === activity.agentId)
          .map((item) => item.id)
          .sort();
        return [
          {
            id: activity.id,
            type: "agent",
            position: { x: activity.x, y: activity.y },
            width: activityWidth,
            height: activityHeight,
            handles: activity.handles,
            draggable: false,
            ariaLabel: activity.record
              ? (activity.record.link?.name ?? t("approval.title"))
              : activity.kind === "approval"
                ? t("approval.title")
                : names.get(activity.id),
            data: {
              agent,
              agentName: `${engineerName(agent)}${peers.length > 1 ? ` · ${peers.indexOf(activity.id) + 1}` : ""}`,
              name: names.get(activity.id) ?? engineerName(agent),
              activity,
              onExplore: props.onExplore ? () => props.onExplore?.(activity) : undefined,
              selected: selectedConnection
                ? layout.connections.some(
                    (connection) =>
                      connection.id === selectedConnection &&
                      (connection.source === activity.id || connection.target === activity.id),
                  )
                : selected === activity.id,
            },
          },
        ];
      }),
    [participants, selected, selectedConnection, layout, names, t, props.onExplore],
  );
  const edges: CollaborationEdge[] = useMemo(() => {
    const name = (activity?: FlowActivity) =>
      activity?.record
        ? (activity.record.link?.name ?? t("approval.title"))
        : activity?.kind === "approval"
          ? t("approval.title")
          : (names.get(activity?.id ?? "") ?? "");
    return layout.connections.flatMap((connection): CollaborationEdge[] => {
      const steps = connectionSteps(connection);
      const step = currentStep(steps);
      const record = connection.records.find((item) => item.step.link.id === step?.link.id);
      if (!step || !record) return [];
      const { link, order } = step;
      const from = layout.activities.find((activity) => activity.id === connection.source);
      const to = layout.activities.find((activity) => activity.id === connection.target);
      const color = appearance(link.state).color;
      const label =
        steps.length > 1
          ? t("graph.rounds", { count: steps.length })
          : `${order ? `${order} · ` : ""}${t(edgeLabel(record, from, to))}`;
      const description = `${name(from)} → ${name(to)} · ${label}`;
      const reverse = connection.records.some((item) =>
        connection.source === connection.target
          ? item.phase === "return"
          : item.source === connection.target && item.target === connection.source,
      );
      return [
        {
          ...connection,
          sourceHandle: connection.route.sourceHandle,
          targetHandle: connection.route.targetHandle,
          type: "collaboration",
          data: {
            label,
            description,
            color,
            selected: selectedConnection === connection.id,
            onCall: () => props.onConnection(connection),
            path: connection.route.path,
            labelPosition: connection.route.label,
          },
          ariaLabel: description,
          animated: running(link.state),
          markerStart: reverse
            ? {
                type: MarkerType.ArrowClosed,
                orient: "auto-start-reverse",
                width: 14,
                height: 14,
                color,
              }
            : undefined,
          markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color },
          style: {
            stroke: color,
            strokeWidth: selectedConnection === connection.id ? 2 : 1.5,
            strokeDasharray: steps.every(
              ({ link }) => link.kind === "background" || link.startedAt === undefined,
            )
              ? "5 5"
              : undefined,
          },
        },
      ];
    });
  }, [names, layout, selectedConnection, props.onConnection, t]);
  const { x: boundsX, y: boundsY, width: boundsWidth, height: boundsHeight } = layout.bounds;
  // Status and selection updates preserve the viewport; topology and size changes refit it.
  useEffect(() => {
    if (!width || !height || !viewportInitialized || !layout.key || positions.isPlaceholderData)
      return;
    if (view.current.key !== layout.key) view.current = { key: layout.key, manual: false };
    const frame = requestAnimationFrame(() => {
      const bounds = diagramBounds(canvas.current, {
        x: boundsX,
        y: boundsY,
        width: boundsWidth,
        height: boundsHeight,
      });
      void setViewport(
        view.current.manual
          ? graphViewport(bounds, width, height, getZoom())
          : graphViewport(bounds, width, height),
      );
    });
    return () => cancelAnimationFrame(frame);
  }, [
    width,
    height,
    viewportInitialized,
    layout.key,
    positions.isPlaceholderData,
    boundsX,
    boundsY,
    boundsWidth,
    boundsHeight,
    setViewport,
    getZoom,
  ]);
  return (
    <ReactFlow<AgentNode, CollaborationEdge>
      ref={canvas}
      ariaLabelConfig={{
        "controls.zoomIn.ariaLabel": t("graph.zoomIn"),
        "controls.zoomOut.ariaLabel": t("graph.zoomOut"),
        "controls.fitView.ariaLabel": t("graph.fit"),
      }}
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      colorMode={resolvedTheme === "dark" ? "dark" : "light"}
      {...zoomLimits}
      onMoveStart={(event) => {
        if (event) manualView();
      }}
      onNodeClick={(_event, node) => props.onSelect(node.data.activity)}
      onEdgeClick={(_event, edge) => {
        const connection = layout.connections.find((item) => item.id === edge.id);
        if (connection) props.onConnection(connection);
      }}
      nodesConnectable={false}
      nodesDraggable={false}
      proOptions={proOptions}
    >
      <Background variant={BackgroundVariant.Dots} color="var(--graph-grid)" gap={22} size={1} />
      <Controls
        showInteractive={false}
        showFitView={false}
        position="bottom-right"
        onZoomIn={manualView}
        onZoomOut={manualView}
      >
        <ControlButton
          className="react-flow__controls-fitview"
          title={t("graph.fit")}
          aria-label={t("graph.fit")}
          onClick={() => {
            view.current.manual = false;
            void setViewport(
              graphViewport(diagramBounds(canvas.current, layout.bounds), width, height),
            );
          }}
        >
          <Maximize2 />
        </ControlButton>
      </Controls>
    </ReactFlow>
  );
}

export function Graph(props: GraphProps) {
  return (
    <ReactFlowProvider>
      <Canvas {...props} />
    </ReactFlowProvider>
  );
}
