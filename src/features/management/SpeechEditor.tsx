import { clone, create, fromJson, type JsonObject, toJson } from "@bufbuild/protobuf";
import { generateForm } from "@rjsf/shadcn";
import validator from "@rjsf/validator-ajv8";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Capability } from "../../../gen/agentos/authorization/v1/permission_pb.js";
import {
  SpeechConfigurationSchema,
  SpeechSynthesisSchema,
  SpeechTranscriptionSchema,
} from "../../../gen/agentos/console/v1/speech_pb.js";
import type { GetSpeechConfigurationResponse } from "../../../gen/agentos/management/v1/management_pb.js";
import { useCapability } from "../../lib/access.js";
import { managementClient } from "../../lib/console.js";
import { translateSchema } from "./connection-schema.js";
import { SaveButton } from "./ResourceDialog.js";
import { Failure } from "./ResourcePage.js";
import { speechSchema } from "./speech-schema.js";

export type SpeechKind = "transcription" | "synthesis";
const Form = generateForm<Record<string, unknown>>();

export function SpeechEditor({
  kind,
  settings,
  onSaved,
}: {
  kind: SpeechKind;
  settings: GetSpeechConfigurationResponse;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const editable = useCapability(Capability.MODELS_MANAGE);
  const query = useQueryClient();
  const provider = settings.configuration?.[kind];
  const [enabled, setEnabled] = useState(!!provider);
  const [credential, setCredential] = useState("");
  const [clearCredential, setClearCredential] = useState(false);
  const credentialConfigured =
    kind === "transcription"
      ? settings.transcriptionCredentialConfigured
      : settings.synthesisCredentialConfigured;
  const [data, setData] = useState<JsonObject>((): JsonObject => {
    const { transcription, synthesis } = settings.configuration ?? {};
    if (kind === "transcription" && transcription)
      return toJson(SpeechTranscriptionSchema, transcription) as JsonObject;
    if (kind === "synthesis" && synthesis)
      return toJson(SpeechSynthesisSchema, synthesis) as JsonObject;
    return kind === "transcription"
      ? {
          endpoint: { baseUrl: "" },
          model: "",
          protocol: "PROTOCOL_WHISPERLIVEKIT",
          languageCodes: ["zh", "en", "ar"],
        }
      : {
          endpoint: { baseUrl: "" },
          protocol: "PROTOCOL_OPENAI",
          voices: [{ languageCode: "zh", model: "", voice: "" }],
        };
  });
  const schemas = useQuery({
    queryKey: ["management", "schemas"],
    queryFn: () => managementClient.getSchemas({}),
    staleTime: Infinity,
  });
  const save = useMutation({
    mutationFn: async (formData: JsonObject) => {
      if (!editable) return;
      const configuration = clone(
        SpeechConfigurationSchema,
        settings.configuration ?? create(SpeechConfigurationSchema),
      );
      if (kind === "transcription")
        configuration.transcription = enabled
          ? fromJson(SpeechTranscriptionSchema, formData)
          : undefined;
      else
        configuration.synthesis = enabled ? fromJson(SpeechSynthesisSchema, formData) : undefined;
      const key = clearCredential ? "" : credential.trim() || undefined;
      return managementClient.saveSpeechConfiguration({
        configuration,
        resourceVersion: settings.resourceVersion,
        ...(kind === "transcription"
          ? { transcriptionCredential: key }
          : { synthesisCredential: key }),
      });
    },
    onSuccess: async () => {
      await query.invalidateQueries();
      onSaved();
    },
  });
  const source =
    kind === "transcription" ? schemas.data?.speechTranscription : schemas.data?.speechSynthesis;
  const controls = (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="speech-credential">{t("management.credential")}</Label>
        <Input
          id="speech-credential"
          type="password"
          autoComplete="new-password"
          value={credential}
          maxLength={8000}
          disabled={clearCredential}
          onChange={(event) => setCredential(event.target.value)}
          placeholder={t("management.credentialKeep")}
        />
        {credentialConfigured && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setClearCredential((value) => !value)}
          >
            {t(clearCredential ? "management.cancel" : "management.speech.clearCredential")}
          </Button>
        )}
      </div>
      <Failure error={save.error} />
      <SaveButton pending={save.isPending} />
    </div>
  );
  return (
    <div className="space-y-5" data-testid="speech-editor">
      <Label>
        <Checkbox
          checked={enabled}
          disabled={save.isPending || !editable}
          onCheckedChange={(checked) => setEnabled(checked === true)}
        />
        {t("management.speech.enabled")}
      </Label>
      {enabled && source ? (
        <Form
          schema={speechSchema(source, t)}
          uiSchema={{
            "ui:submitButtonOptions": { norender: !editable },
            "ui:order":
              kind === "transcription"
                ? ["endpoint", "model", "protocol", "languageCodes", "*"]
                : ["endpoint", "protocol", "voices", "*"],
            languageCodes: { items: { "ui:title": t("management.speech.fields.languageCode") } },
          }}
          validator={validator}
          translateString={translateSchema(t)}
          formData={data}
          disabled={save.isPending}
          readonly={!editable}
          showErrorList={false}
          onChange={(event) => {
            if (event.formData) setData(event.formData as JsonObject);
          }}
          onSubmit={(event) => {
            if (event.formData) save.mutate(event.formData as JsonObject);
          }}
        >
          {editable && controls}
        </Form>
      ) : !enabled && editable ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate(data);
          }}
        >
          <Failure error={save.error} />
          <SaveButton pending={save.isPending} />
        </form>
      ) : null}
      <Failure error={schemas.error} />
    </div>
  );
}
