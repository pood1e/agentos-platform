import {
  Background,
  BackgroundVariant,
  Controls,
  type FitViewOptions,
  MarkerType,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useStore,
} from "@xyflow/react";
import { useTheme } from "next-themes";
import { useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { Engineer } from "../../../gen/agentos/console/v1/engineer_pb.js";
import type { ActivityState } from "../../../gen/agentos/console/v1/state_pb.js";
import { InteractionKind } from "../../../gen/agentos/console/v1/task_pb.js";
import { engineerName } from "../shared/engineers.js";
import { appearance } from "../status/Status.js";
import type { CollaborationFlow, FlowActivity, FlowConnection } from "./flow/collaboration-flow.js";
import { activityHeight, activityWidth, collaborationLayout } from "./flow/collaboration-layout.js";
import { type Link, running } from "./flow/links.js";
import { type CollaborationEdge, GraphEdge } from "./GraphEdge.js";
import { AgentCard, type AgentNode } from "./GraphNode.js";

const nodeTypes = { agent: AgentCard };
const edgeTypes = { collaboration: GraphEdge };
const proOptions = { hideAttribution: true };
const zoomLimits = { minZoom: 0.15, maxZoom: 2 };
const fitOptions: FitViewOptions = { ...zoomLimits, padding: 0.12, duration: 0 };

export interface GraphProps {
  participants: Engineer[];
  flow: CollaborationFlow;
  rootState: ActivityState;
  selected: string;
  selectedCall: string;
  onSelect: (activity: FlowActivity) => void;
  onCall: (callKey: string) => void;
}

const kindLabels: Record<Link["kind"], string> = {
  invoke: "graph.delegate",
  background: "graph.backgroundDispatch",
  handoff: "graph.transfer",
  resume: "graph.continue",
  approval: "graph.requestApproval",
  review: "graph.review",
};

function edgeLabel(connection: FlowConnection, target?: FlowActivity) {
  if (connection.phase === "approval") {
    if (target?.kind === "review") return "graph.review";
    if (target?.kind !== "approval") return "graph.resumeExecution";
    return target.interaction?.kind === InteractionKind.QUESTION
      ? "graph.requestInput"
      : "graph.requestApproval";
  }
  return connection.phase === "return" ? "graph.return" : kindLabels[connection.link.kind];
}

function Canvas(props: GraphProps) {
  const { participants, flow, selected, selectedCall } = props;
  const { t } = useTranslation();
  const { resolvedTheme } = useTheme();
  const layout = useMemo(() => collaborationLayout(flow), [flow]);
  const { fitView, getZoom, viewportInitialized } = useReactFlow();
  const width = useStore((state) => state.width);
  const height = useStore((state) => state.height);
  const view = useRef({ key: "", manual: false });
  const manualView = () => {
    view.current.manual = true;
  };
  const nodes: AgentNode[] = useMemo(
    () =>
      layout.activities.flatMap((activity): AgentNode[] => {
        const agent = participants.find((item) => item.id === activity.agentId);
        if (!agent) return [];
        return [
          {
            id: activity.id,
            type: "agent",
            position: { x: activity.x, y: activity.y },
            width: activityWidth,
            height: activityHeight,
            draggable: false,
            ariaLabel: activity.kind === "approval" ? t("approval.title") : engineerName(agent),
            data: {
              agent,
              activity,
              selected: selectedCall
                ? selectedCall === activity.step?.link.callKey
                : selected === activity.id,
              rootState: props.rootState,
            },
          },
        ];
      }),
    [participants, props.rootState, selected, selectedCall, layout, t],
  );
  const edges: CollaborationEdge[] = useMemo(() => {
    const orders = new Map(layout.steps.map((step) => [step.link.id, step.order]));
    const name = (activity?: FlowActivity) =>
      activity?.kind === "approval"
        ? t("approval.title")
        : engineerName(
            participants.find((item) => item.id === activity?.agentId) ?? {
              id: "",
              name: "",
              role: "",
            },
          );
    return layout.connections.map((connection) => {
      const { link, phase } = connection;
      const from = layout.activities.find((activity) => activity.id === connection.source);
      const to = layout.activities.find((activity) => activity.id === connection.target);
      const returning = phase === "return";
      const color = appearance(link.state).color;
      const order = orders.get(link.id);
      const prefix =
        phase === "approval" || link.kind === "resume" || order === undefined ? "" : `#${order} `;
      const label = `${prefix}${t(edgeLabel(connection, to))}`;
      const description = `${name(from)} → ${name(to)} · ${label}`;
      return {
        ...connection,
        type: "collaboration",
        data: {
          label,
          description,
          color,
          selected: selectedCall === link.callKey,
          callKey: link.callKey,
          onCall: props.onCall,
        },
        ariaLabel: description,
        animated: !returning && running(link.state),
        markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color },
        style: {
          stroke: color,
          strokeWidth: selectedCall === link.callKey ? 2 : 1.5,
          strokeDasharray:
            returning || link.kind === "background" || link.startedAt === undefined
              ? "5 5"
              : undefined,
        },
      };
    });
  }, [participants, layout, selectedCall, props.onCall, t]);
  // Status and selection updates preserve the viewport; topology and size changes refit it.
  useEffect(() => {
    if (!width || !height || !viewportInitialized || !layout.key) return;
    if (view.current.key !== layout.key) view.current = { key: layout.key, manual: false };
    const frame = requestAnimationFrame(() => {
      void fitView(view.current.manual ? { ...fitOptions, maxZoom: getZoom() } : fitOptions);
    });
    return () => cancelAnimationFrame(frame);
  }, [width, height, viewportInitialized, layout.key, fitView, getZoom]);
  return (
    <ReactFlow<AgentNode, CollaborationEdge>
      ariaLabelConfig={{
        "controls.zoomIn.ariaLabel": t("graph.zoomIn"),
        "controls.zoomOut.ariaLabel": t("graph.zoomOut"),
        "controls.fitView.ariaLabel": t("graph.fit"),
      }}
      nodes={nodes}
      edges={edges}
      fitView
      fitViewOptions={fitOptions}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      colorMode={resolvedTheme === "dark" ? "dark" : "light"}
      {...zoomLimits}
      onMoveStart={(event) => {
        if (event) manualView();
      }}
      onNodeClick={(_event, node) => props.onSelect(node.data.activity)}
      onEdgeClick={(_event, edge) => {
        if (edge.data?.callKey) props.onCall(edge.data.callKey);
      }}
      nodesConnectable={false}
      nodesDraggable={false}
      proOptions={proOptions}
    >
      <Background variant={BackgroundVariant.Dots} color="var(--graph-grid)" gap={22} size={1} />
      <Controls
        showInteractive={false}
        fitViewOptions={fitOptions}
        position="bottom-right"
        onZoomIn={manualView}
        onZoomOut={manualView}
        onFitView={() => {
          view.current.manual = false;
        }}
      />
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
