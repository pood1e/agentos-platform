import type { JsonObject } from "@bufbuild/protobuf";
import { generateForm } from "@rjsf/shadcn";
import type { RJSFSchema } from "@rjsf/utils";
import validator from "@rjsf/validator-ajv8";
import { type Dispatch, type SetStateAction, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { object } from "../../../shared/json.js";
import { translateSchema } from "../management/connection-schema.js";
import {
  edgeKey,
  editDocument,
  type GraphScope,
  graphScopes,
  nativeDocument,
  replaceNode,
} from "./document.js";

const Form = generateForm<Record<string, unknown>>();

export function WorkflowProperties({
  scope,
  selected,
  edge,
  schema,
  editable,
  sourceText,
  setSource,
}: {
  scope: GraphScope;
  selected: string;
  edge: boolean;
  schema: RJSFSchema;
  editable: boolean;
  sourceText: string;
  setSource: Dispatch<SetStateAction<string>>;
}) {
  const { t } = useTranslation();
  const [error, setError] = useState("");
  const index = scope.nodes.findIndex((node) => node.id === selected);
  const node = scope.nodes[index];
  const edgeIndex = scope.edges.findIndex((edge) => edgeKey(edge) === selected);
  const connection = edge ? scope.edges[edgeIndex] : undefined;
  if (edge)
    return connection ? (
      <div className="space-y-3 p-4">
        <p className="font-mono text-xs">
          {connection.from} → {connection.to}
        </p>
        <Label htmlFor="workflow-route">{t("workflow.route")}</Label>
        <Input
          id="workflow-route"
          value={connection.route ?? ""}
          disabled={!editable}
          onChange={(event) =>
            setSource((source) =>
              editDocument(source, (document) => {
                const path = [...scope.path, "edges", edgeIndex, "route"];
                if (event.target.value) document.setIn(path, event.target.value);
                else document.deleteIn(path);
              }),
            )
          }
        />
      </div>
    ) : null;
  if (!node) return <p className="p-4 text-sm text-muted-foreground">{t("workflow.selectNode")}</p>;
  const variants = ((schema.$defs?.Node as RJSFSchema | undefined)?.oneOf ?? []) as RJSFSchema[];
  const source = variants.find((item) =>
    (item.properties?.type as RJSFSchema | undefined)?.enum?.includes(node.type),
  );
  if (!source) return null;
  const fields = Object.fromEntries(
    Object.entries(source.properties ?? {}).filter(
      ([key]) => !["type", "nodes", "edges", "input_schema", "output_schema"].includes(key),
    ),
  );
  const formSchema: RJSFSchema = {
    ...source,
    $defs: schema.$defs,
    title: node.type,
    properties: fields,
    required: source.required?.filter((key) => key in fields),
  };
  const formData = Object.fromEntries(
    Object.entries(node).filter(([key]) => key in fields),
  ) as JsonObject;
  return (
    <div className="p-4">
      <Form
        key={`${scope.id}/${selected}`}
        schema={formSchema}
        validator={validator}
        formData={formData}
        readonly={!editable}
        translateString={translateSchema(t)}
        uiSchema={{
          "ui:globalOptions": { enableOptionalDataFieldForType: ["object", "array"] },
          instruction: { "ui:widget": "textarea" },
          message: { "ui:widget": "textarea" },
        }}
        experimental_defaultFormStateBehavior={{
          emptyObjectFields: "populateRequiredDefaults",
          arrayMinItems: { populate: "requiredOnly" },
        }}
        onSubmit={(event) => {
          if (!event.formData || !editable) return;
          const data = event.formData;
          try {
            const current = graphScopes(nativeDocument(sourceText).value).find(
              (item) => item.id === scope.id,
            );
            if (!current) return;
            const existing = current.nodes.findIndex((item) => item.id === selected);
            if (existing < 0) return;
            const next = object(JSON.parse(JSON.stringify(current.nodes[existing])));
            for (const key of Object.keys(fields)) delete next[key];
            Object.assign(next, data);
            setSource(replaceNode(sourceText, current, existing, next as unknown as typeof node));
            setError("");
          } catch (error) {
            setError(error instanceof Error ? error.message : String(error));
          }
        }}
      >
        {editable && (
          <Button type="submit" className="w-full">
            {t("workflow.applyNode")}
          </Button>
        )}
      </Form>
      {error && (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
