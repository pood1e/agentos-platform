import "@xyflow/react/dist/style.css";
import "./workflows.css";
import { Background, ReactFlow } from "@xyflow/react";
import { useTheme } from "next-themes";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import type { CollaborationWorkflow } from "../../../gen/agentos/console/v1/pack_pb.js";
import { WorkflowEdge } from "./WorkflowEdge.js";
import { WorkflowStage, WorkflowStep } from "./WorkflowStep.js";
import { FitGraphOnResize, GraphControls } from "./workflow-fit.js";
import { workflowGraph } from "./workflow-graph.js";

const nodeTypes = { step: WorkflowStep, stage: WorkflowStage };
const edgeTypes = { workflow: WorkflowEdge };

export function Workflows({ workflows }: { workflows: CollaborationWorkflow[] }) {
  const { t } = useTranslation();
  const { resolvedTheme } = useTheme();
  const [selected, setSelected] = useState("");
  const workflow = workflows.find((item) => item.id === selected) ?? workflows[0];
  if (!workflow) return null;
  const translate = (key: string) => t(key, { defaultValue: key });
  const { nodes, edges, bounds } = workflowGraph(workflow, translate);
  const rows = [...new Set(workflow.nodes.map((node) => node.row))].sort((a, b) => a - b);
  return (
    <section className="workflow-section" aria-label={t("workflows.title")}>
      <div className="workflow-toolbar">
        <h2 className="text-base font-semibold">{t("workflows.title")}</h2>
        <fieldset aria-label={t("workflows.select")} className="flex flex-wrap gap-2">
          {workflows.map((item) => (
            <Button
              key={item.id}
              size="sm"
              variant={workflow.id === item.id ? "default" : "outline"}
              aria-pressed={workflow.id === item.id}
              onClick={() => setSelected(item.id)}
            >
              {translate(item.title)}
            </Button>
          ))}
        </fieldset>
        <div className="workflow-legend">
          <span className="workflow-sync">{t("workflows.sync")}</span>
          <span className="workflow-async">{t("workflows.async")}</span>
        </div>
      </div>
      <div className="workflow-graph" role="img" aria-label={translate(workflow.title)}>
        <ReactFlow
          key={workflow.id}
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          colorMode={resolvedTheme === "dark" ? "dark" : "light"}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          fitView={!bounds}
          fitViewOptions={{ padding: 0.05 }}
          minZoom={0.1}
        >
          <Background />
          <GraphControls bounds={bounds} label={t("workflows.fit")} />
          <FitGraphOnResize padding={0.05} bounds={bounds} />
        </ReactFlow>
      </div>
      <div className="workflow-mobile">
        {rows.map((row) => (
          <section key={row}>
            {workflow.stages.find((stage) => stage.row === row)?.title && (
              <h3>{translate(workflow.stages.find((stage) => stage.row === row)?.title ?? "")}</h3>
            )}
            <ol>
              {workflow.nodes
                .filter((node) => node.row === row)
                .map((node) => (
                  <li key={node.id}>
                    <strong>{translate(node.title)}</strong>
                    {workflow.edges
                      .filter((edge) => edge.source === node.id)
                      .map((edge) => (
                        <small key={`${edge.source}-${edge.target}`}>
                          {edge.label && translate(edge.label)} →{" "}
                          {translate(
                            workflow.nodes.find((item) => item.id === edge.target)?.title ?? "",
                          )}
                        </small>
                      ))}
                  </li>
                ))}
            </ol>
          </section>
        ))}
      </div>
    </section>
  );
}
