import { create, type JsonObject } from "@bufbuild/protobuf";
import { generateForm } from "@rjsf/shadcn";
import type { RJSFSchema } from "@rjsf/utils";
import validator from "@rjsf/validator-ajv8";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Capability } from "../../../gen/agentos/authorization/v1/permission_pb.js";
import { type Harness, HarnessSchema } from "../../../gen/kagent/api/v1alpha1/harnesses_pb.js";
import { useCapability } from "../../lib/access.js";
import { managementClient } from "../../lib/console.js";
import { HarnessIcon, runtimeName } from "../shared/HarnessIcon.js";
import { localizedSchema, object, translateSchema } from "./connection-schema.js";
import { harnessName } from "./HarnessPicker.js";
import { SaveButton } from "./ResourceDialog.js";
import { Failure } from "./ResourcePage.js";

const Form = generateForm<Record<string, unknown>>();
const runtimes = ["kagent", "codex", "claude", "byo"];

export function HarnessEditor({
  harness,
  defaults,
  onSaved,
}: {
  harness?: Harness;
  defaults?: Harness;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const editable = useCapability(Capability.HARNESSES_MANAGE);
  const [name, setName] = useState(harness ? harnessName(harness) : "");
  const [runtime, setRuntime] = useState(harness?.runtime ?? "byo");
  const [spec, setSpec] = useState<JsonObject>(() =>
    harness
      ? structuredClone(object(harness.resource?.value?.spec))
      : {
          byo: {},
          workload: { image: "", command: [] },
          substrate: structuredClone(
            object(defaults?.resource?.value?.spec).substrate ?? {
              workerPoolRef: { name: "" },
              snapshotPolicy: { location: "" },
            },
          ),
        },
  );
  const schemas = useQuery({
    queryKey: ["management", "schemas"],
    queryFn: () => managementClient.getSchemas({}),
    staleTime: Infinity,
  });
  const save = useMutation({
    mutationFn: (value: JsonObject) =>
      managementClient.saveHarness({
        create: !harness,
        harness: create(HarnessSchema, {
          ref: { name, namespace: harness?.ref?.namespace ?? defaults?.ref?.namespace ?? "" },
          resource: { apiVersion: "api.kagent.dev/v1alpha3", kind: "Harness", value },
        }),
      }),
    onSuccess: onSaved,
  });
  const source = schemas.data?.harness;
  const schema = source
    ? localizedSchema(source as RJSFSchema, t, "", "harness.fields")
    : undefined;
  if (schema?.properties) {
    for (const key of runtimes)
      if (key !== "kagent" || runtime !== "kagent") delete schema.properties[key];
    if (runtime === "byo") {
      const workload = schema.properties.workload as RJSFSchema;
      schema.properties.workload = {
        ...workload,
        required: [...(workload.required ?? []), "command"],
      };
    }
  }
  function submit(data: JsonObject) {
    if (!editable) return;
    const value: JsonObject = harness
      ? structuredClone(harness.resource?.value ?? {})
      : { apiVersion: "api.kagent.dev/v1alpha3", kind: "Harness", metadata: { name } };
    const next = { ...data };
    for (const key of runtimes) delete next[key];
    next[runtime] = object(data[runtime]);
    value.spec = next;
    save.mutate(value);
  }
  return (
    <div className="space-y-5" data-testid="harness-editor">
      <div className="space-y-2">
        <Label htmlFor="harness-name">{t("configuration.identifier")}</Label>
        <Input
          id="harness-name"
          form="harness-form"
          required
          pattern="[a-z0-9](([a-z0-9]|-)*[a-z0-9])?"
          value={name}
          onChange={(event) => setName(event.target.value)}
          disabled={!!harness || !editable}
        />
      </div>
      <div className="space-y-2">
        <Label>{t("harness.runtime")}</Label>
        <Select value={runtime} onValueChange={setRuntime} disabled={save.isPending || !editable}>
          <SelectTrigger aria-label={t("harness.runtime")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {runtimes.map((key) => (
              <SelectItem key={key} value={key}>
                <HarnessIcon
                  runtime={key}
                  className="size-5 rounded-none border-0 bg-transparent"
                />
                {runtimeName(key)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {schema && (
        <Form
          id="harness-form"
          schema={schema}
          validator={validator}
          formData={spec}
          experimental_defaultFormStateBehavior={{
            emptyObjectFields: "populateRequiredDefaults",
            arrayMinItems: { populate: "requiredOnly" },
          }}
          uiSchema={{ "ui:globalOptions": { enableOptionalDataFieldForType: ["object", "array"] } }}
          translateString={translateSchema(t)}
          disabled={save.isPending}
          readonly={!editable}
          showErrorList="top"
          onChange={(event) => {
            if (event.formData) setSpec(event.formData as JsonObject);
          }}
          onSubmit={(event) => {
            if (event.formData) submit(event.formData as JsonObject);
          }}
        >
          <Failure error={save.error} />
          {editable && <SaveButton pending={save.isPending} />}
        </Form>
      )}
      <Failure error={schemas.error} />
    </div>
  );
}
