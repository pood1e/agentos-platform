import { clone, create, type JsonObject } from "@bufbuild/protobuf";
import { generateForm } from "@rjsf/shadcn";
import validator from "@rjsf/validator-ajv8";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  type Connection,
  ConnectionKind,
  ConnectionSchema,
} from "../../../gen/agentos/management/v1/management_pb.js";
import { managementClient } from "../../lib/console.js";
import { ToolIcon } from "../shared/ToolIcon.js";
import { toolText } from "../shared/tool-label.js";
import {
  connectionLabel,
  connectionName,
  connectionSchema,
  metadata,
  native,
  object,
  translateSchema,
} from "./connection-schema.js";
import { ModelRequestOptions } from "./ModelRequestOptions.js";
import { SaveButton } from "./ResourceDialog.js";
import { Failure } from "./ResourcePage.js";

const Form = generateForm<Record<string, unknown>>();

export function ConnectionEditor({
  kind,
  connection,
  onSaved,
}: {
  kind: ConnectionKind;
  connection?: Connection;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(connection ? connectionName(connection) : "");
  const [credential, setCredential] = useState("");
  const [displayName, setDisplayName] = useState(connection ? connectionLabel(connection) : "");
  const [spec, setSpec] = useState<JsonObject>(
    (): JsonObject =>
      connection
        ? structuredClone(object(native(connection).spec))
        : kind === ConnectionKind.MODEL
          ? { provider: "OpenAI", baseURL: "https://api.openai.com/v1", match: { model: "" } }
          : {
              mcp: {
                targets: [
                  {
                    name: "server",
                    static: { host: "", port: 8080, path: "/mcp", protocol: "StreamableHTTP" },
                  },
                ],
              },
            },
  );
  const [request, setRequest] = useState<JsonObject>(() =>
    connection?.model?.resource?.value?.spec
      ? structuredClone(object(connection.model.resource.value.spec))
      : { provider: "OpenAI", openAI: { apiFormat: "chatCompletions" } },
  );
  const [tls, setTLS] = useState(() => {
    const targets = object(spec.mcp).targets;
    return (
      Array.isArray(targets) &&
      targets.some((target) => object(object(object(target).static).policies).tls !== undefined)
    );
  });
  const schemas = useQuery({
    queryKey: ["management", "schemas"],
    queryFn: () => managementClient.getSchemas({}),
    staleTime: Infinity,
  });
  const save = useMutation({
    mutationFn: (connection: Connection) =>
      managementClient.saveConnection({
        connection,
        create: !metadata(connection).resourceVersion,
        credential: credential.trim() || undefined,
      }),
    onSuccess: onSaved,
  });
  function submit(data: JsonObject) {
    if (kind === ConnectionKind.MCP) {
      const targets = object(data.mcp).targets;
      if (Array.isArray(targets))
        for (const target of targets) {
          const backend = object(object(target).static);
          const policies = { ...object(backend.policies) };
          if (tls) policies.tls = {};
          else delete policies.tls;
          if (Object.keys(policies).length) backend.policies = policies;
          else delete backend.policies;
        }
    }
    const value: JsonObject = connection
      ? structuredClone(native(connection))
      : {
          apiVersion: "agentgateway.dev/v1alpha1",
          kind: kind === ConnectionKind.MODEL ? "AgentgatewayModel" : "AgentgatewayBackend",
          metadata: { name },
        };
    value.spec = data;
    if (kind === ConnectionKind.MCP && displayName.trim()) {
      const meta = object(value.metadata);
      value.metadata = {
        ...meta,
        annotations: {
          ...object(meta.annotations),
          "agentos.dev/display-name": displayName.trim(),
        },
      };
    }
    const draft = connection
      ? clone(ConnectionSchema, connection)
      : create(ConnectionSchema, { kind });
    draft.resource = {
      $typeName: "kagent.api.v1alpha1.StructuredObject",
      apiVersion: String(value.apiVersion),
      kind: String(value.kind),
      value,
    };
    if (kind === ConnectionKind.MODEL)
      draft.model = {
        $typeName: "kagent.api.v1alpha1.ModelConfig",
        resource: {
          $typeName: "kagent.api.v1alpha1.StructuredObject",
          apiVersion: "api.kagent.dev/v1alpha3",
          kind: "ModelConfig",
          value: {
            spec: request,
          },
        },
      };
    save.mutate(draft);
  }
  const source = kind === ConnectionKind.MODEL ? schemas.data?.model : schemas.data?.mcp;
  return (
    <div className="space-y-5" data-testid="connection-editor">
      {kind === ConnectionKind.MCP && (
        <div className="space-y-2">
          <Label htmlFor="connection-label">{t("configuration.name")}</Label>
          <Input
            id="connection-label"
            form="connection-form"
            value={displayName}
            maxLength={80}
            disabled={connection?.systemManaged}
            onChange={(event) => setDisplayName(event.target.value)}
          />
        </div>
      )}
      <div className="space-y-2">
        <Label htmlFor="connection-name">{t("configuration.identifier")}</Label>
        <Input
          id="connection-name"
          form="connection-form"
          required
          pattern="[a-z0-9]([-a-z0-9]*[a-z0-9])?"
          maxLength={63}
          value={name}
          disabled={!!connection}
          onChange={(event) => setName(event.target.value)}
        />
      </div>
      {source && (
        <Form
          id="connection-form"
          schema={connectionSchema(source, kind, t)}
          validator={validator}
          translateString={translateSchema(t)}
          formData={spec}
          disabled={connection?.systemManaged || save.isPending}
          showErrorList={false}
          onChange={(event) => {
            if (event.formData) setSpec(event.formData as JsonObject);
          }}
          onSubmit={(event) => {
            if (event.formData) submit(event.formData as JsonObject);
          }}
        >
          {kind === ConnectionKind.MODEL ? (
            <ModelRequestOptions
              spec={request}
              onChange={setRequest}
              disabled={!!connection?.systemManaged}
            />
          ) : (
            <Label className="mb-5">
              <Checkbox
                checked={tls}
                disabled={connection?.systemManaged}
                onCheckedChange={(checked) => setTLS(checked === true)}
              />
              {t("management.tls")}
            </Label>
          )}
          {!connection?.systemManaged && (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="connection-credential">{t("management.credential")}</Label>
                <Input
                  id="connection-credential"
                  type="password"
                  autoComplete="new-password"
                  value={credential}
                  maxLength={8000}
                  onChange={(event) => setCredential(event.target.value)}
                  placeholder={t(
                    connection ? "management.credentialKeep" : "management.credentialOptional",
                  )}
                />
              </div>
              <Failure error={save.error} />
              <SaveButton pending={save.isPending} />
            </div>
          )}
        </Form>
      )}
      <Failure error={schemas.error} />
      {!!connection?.tools.length && (
        <div className="space-y-3">
          <h2 className="text-sm font-medium">
            {t("management.discoveredTools", { count: connection.tools.length })}
          </h2>
          {connection.tools.map((tool) => {
            const text = toolText(tool.name, tool.description);
            return (
              <div key={tool.name} className="flex gap-3 rounded-lg border p-3">
                <ToolIcon name={tool.name} server={name} />
                <div>
                  <p className="text-sm font-medium">{text.name}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{text.description}</p>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
