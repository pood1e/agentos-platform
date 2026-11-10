import "@xyflow/react/dist/style.css";
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
} from "@xyflow/react";
import { useTheme } from "next-themes";
import type { Dispatch, SetStateAction } from "react";
import { useTranslation } from "react-i18next";
import type { WorkflowLayout } from "../../../gen/agentos/management/v1/workflow_pb.js";
import {
  appendEdge,
  edgeKey,
  editDocument,
  type GraphScope,
  graphScopes,
  nativeDocument,
  position,
  removeNodes,
} from "./document.js";

type Step = Node<{ label: string; kind: string; selected: boolean }, "step">;
function StepNode({ data }: NodeProps<Step>) {
  return (
    <div
      className={`min-w-40 rounded-lg border bg-card p-3 shadow-sm ${data.selected ? "ring-2 ring-ring" : ""}`}
    >
      {data.kind !== "START" && <Handle type="target" position={Position.Left} />}
      <span className="block text-[10px] uppercase text-muted-foreground">{data.kind}</span>
      <strong className="block max-w-48 truncate text-sm">{data.label}</strong>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
const nodeTypes = { step: StepNode };

export function WorkflowCanvas({
  scope,
  layout,
  selected,
  editable,
  setSource,
  setLayout,
  onSelect,
}: {
  scope: GraphScope;
  layout: WorkflowLayout;
  selected: { id: string; edge: boolean };
  editable: boolean;
  setSource: Dispatch<SetStateAction<string>>;
  setLayout: Dispatch<SetStateAction<WorkflowLayout>>;
  onSelect: (id: string, edge: boolean) => void;
}) {
  const { resolvedTheme } = useTheme();
  const { t } = useTranslation();
  const nodes: Step[] = [
    {
      id: "START",
      type: "step",
      position: { x: 0, y: 120 },
      deletable: false,
      draggable: false,
      selected: !selected.edge && selected.id === "START",
      data: { label: "START", kind: "START", selected: !selected.edge && selected.id === "START" },
    },
    ...scope.nodes.map((node, index): Step => {
      const saved = layout.nodes.find((item) => item.path === `${scope.id}/${node.id}`);
      return {
        id: node.id,
        type: "step",
        position: saved
          ? { x: saved.x, y: saved.y }
          : { x: (index + 1) * 230, y: 120 + (index % 2) * 140 },
        selected: !selected.edge && selected.id === node.id,
        data: {
          label: node.id,
          kind: node.type,
          selected: !selected.edge && selected.id === node.id,
        },
      };
    }),
  ];
  const edges = scope.edges.map((edge) => ({
    id: edgeKey(edge),
    source: edge.from,
    target: edge.to,
    label: edge.route,
    selected: selected.edge && selected.id === edgeKey(edge),
    markerEnd: { type: MarkerType.ArrowClosed },
  }));
  if (
    scope.entry &&
    !scope.edges.some((edge) => edge.from === "START" && edge.to === scope.entry && !edge.route)
  )
    edges.push({
      id: "entry",
      source: "START",
      target: scope.entry,
      label: undefined,
      selected: selected.edge && selected.id === "entry",
      markerEnd: { type: MarkerType.ArrowClosed },
    });
  const current = (source: string) =>
    graphScopes(nativeDocument(source).value).find((graph) => graph.id === scope.id);
  return (
    <section className="min-h-96 flex-1 rounded-lg border" aria-label={t("workflow.canvas")}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        colorMode={resolvedTheme === "dark" ? "dark" : "light"}
        fitView
        minZoom={0.1}
        nodesDraggable={editable}
        nodesConnectable={editable}
        deleteKeyCode={editable ? ["Backspace", "Delete"] : null}
        multiSelectionKeyCode={null}
        onPaneClick={() => onSelect("", false)}
        onNodeClick={(_, node) => onSelect(node.id, false)}
        onEdgeClick={(_, edge) => onSelect(edge.id, true)}
        onNodesChange={(changes) => {
          for (const change of changes)
            if (editable && change.type === "position" && change.position)
              setLayout((value) =>
                position(
                  value,
                  `${scope.id}/${change.id}`,
                  change.position?.x ?? 0,
                  change.position?.y ?? 0,
                ),
              );
        }}
        onConnect={(connection) => {
          if (editable)
            setSource((source) => {
              const graph = current(source);
              return graph
                ? appendEdge(source, graph, connection.source, connection.target)
                : source;
            });
        }}
        onNodesDelete={(deleted) =>
          setSource((source) => {
            const graph = current(source);
            return graph
              ? removeNodes(
                  source,
                  graph,
                  deleted.map((node) => node.id),
                )
              : source;
          })
        }
        onEdgesDelete={(deleted) =>
          setSource((source) => {
            const graph = current(source);
            if (!graph) return source;
            const ids = new Set(deleted.map((edge) => edge.id));
            return editDocument(source, (document) => {
              document.setIn(
                [...graph.path, "edges"],
                graph.edges.filter((edge) => !ids.has(edgeKey(edge))),
              );
              if (ids.has("entry")) document.deleteIn([...graph.path, "entry"]);
            });
          })
        }
      >
        <Background />
        <Controls showInteractive={false} />
      </ReactFlow>
    </section>
  );
}
