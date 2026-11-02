import type { RJSFSchema } from "@rjsf/utils";
import type { Dispatch, SetStateAction } from "react";
import { useTranslation } from "react-i18next";
import type { WorkflowLayout } from "../../../gen/agentos/management/v1/workflow_pb.js";
import type { Node as WorkflowNode } from "../../../gen/kagent/workflow.js";
import { editDocument, type GraphScope, newNode } from "./document.js";
import { WorkflowCanvas } from "./WorkflowCanvas.js";
import { WorkflowProperties } from "./WorkflowProperties.js";

const palette: WorkflowNode["type"][] = [
  "agent",
  "llm",
  "cel",
  "tool",
  "join",
  "hitl",
  "workflow",
  "parallel_worker",
];

export function WorkflowGraph({
  scopes,
  scope,
  source,
  layout,
  selected,
  schema,
  editable,
  setSource,
  setLayout,
  onScope,
  onSelect,
}: {
  scopes: GraphScope[];
  scope?: GraphScope;
  source: string;
  layout: WorkflowLayout;
  selected: { id: string; edge: boolean };
  schema?: RJSFSchema;
  editable: boolean;
  setSource: Dispatch<SetStateAction<string>>;
  setLayout: Dispatch<SetStateAction<WorkflowLayout>>;
  onScope: (id: string) => void;
  onSelect: (id: string, edge: boolean) => void;
}) {
  const { t } = useTranslation();
  if (!scope)
    return <p className="text-sm text-muted-foreground">{t("workflow.sourceForComposite")}</p>;
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label={t("workflow.scope")}
          className="h-8 rounded border bg-background px-2 text-xs"
          value={scope.id}
          onChange={(event) => {
            onScope(event.target.value);
            onSelect("", false);
          }}
        >
          {scopes.map((item) => (
            <option key={item.id}>{item.id}</option>
          ))}
        </select>
        {editable && (
          <select
            aria-label={t("workflow.addNode")}
            className="h-8 rounded border bg-background px-2 text-xs"
            value=""
            onChange={(event) => {
              const node = newNode(event.target.value as WorkflowNode["type"], scope);
              setSource((source) =>
                editDocument(source, (document) =>
                  document.setIn([...scope.path, "nodes"], [...scope.nodes, node]),
                ),
              );
              onSelect(node.id, false);
            }}
          >
            <option value="">{t("workflow.addNode")}</option>
            {palette.map((kind) => (
              <option key={kind} value={kind}>
                {kind}
              </option>
            ))}
          </select>
        )}
      </div>
      <div className="flex min-h-[28rem] flex-1 flex-col gap-3 xl:flex-row">
        <WorkflowCanvas
          key={scope.id}
          scope={scope}
          layout={layout}
          selected={selected}
          editable={editable}
          setSource={setSource}
          setLayout={setLayout}
          onSelect={onSelect}
        />
        {schema && (
          <aside className="max-h-[40rem] overflow-y-auto rounded-lg border xl:w-80 xl:shrink-0">
            <WorkflowProperties
              key={`${scope.id}/${selected.id}`}
              scope={scope}
              sourceText={source}
              selected={selected.id}
              edge={selected.edge}
              editable={editable}
              schema={schema}
              setSource={setSource}
            />
          </aside>
        )}
      </div>
    </>
  );
}
