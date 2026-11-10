import { create, type JsonObject } from "@bufbuild/protobuf";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { GetConfigurationResponse } from "../../../gen/agentos/console/v1/console_service_pb.js";
import { ToolBindingSchema } from "../../../gen/agentos/console/v1/role_pb.js";
import { object, text } from "../../../shared/json.js";
import { useAccess } from "../../lib/access.js";
import { consoleClient } from "../../lib/console.js";
import { ModelConfigSelect } from "../agents/ModelConfigSelect.js";
import { ToolBindingsEditor } from "../agents/ToolBindingsEditor.js";
import { WorkflowFailure } from "./WorkflowFailure.js";

export function WorkflowSettings({
  spec,
  identity,
  editable,
  configuration,
  onChange,
}: {
  spec: JsonObject;
  identity: string;
  editable: boolean;
  configuration?: GetConfigurationResponse;
  onChange: (value: JsonObject) => void;
}) {
  const { t } = useTranslation();
  const access = useAccess().data;
  const policy = useQuery({
    queryKey: ["workflows", "tools", access?.workspace?.uid, access?.subject, identity],
    queryFn: () => consoleClient.explainTools({ identity }),
    enabled: !!identity,
  });
  const bindings = (Array.isArray(spec.tools) ? spec.tools : []).map((entry) => {
    const mcp = object(object(entry).mcp);
    return create(ToolBindingSchema, {
      server: text(object(mcp.server).name),
      tools: Array.isArray(mcp.tools)
        ? mcp.tools.filter((tool): tool is string => typeof tool === "string")
        : [],
      requireApproval: mcp.requireApproval === true,
    });
  });
  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <Label htmlFor="workflow-description">{t("configuration.description")}</Label>
        <Input
          id="workflow-description"
          value={text(spec.description)}
          disabled={!editable}
          onChange={(event) => onChange({ ...spec, description: event.target.value })}
        />
      </div>
      {configuration && (
        <>
          <ModelConfigSelect
            value={
              configuration.modelConfigs.find(
                (model) => model.ref?.name === text(object(spec.modelConfig).name),
              )?.ref
            }
            models={configuration.modelConfigs}
            disabled={!editable}
            onChange={(next) => onChange({ ...spec, modelConfig: { name: next?.name ?? "" } })}
          />
          <WorkflowFailure error={policy.error} />
          <ToolBindingsEditor
            identity={identity}
            bindings={bindings}
            disabled={!editable}
            servers={configuration.toolServers}
            requirements={policy.data?.requirements}
            onChange={(next) =>
              onChange({
                ...spec,
                tools: next.map((binding) => ({
                  mcp: {
                    server: { kind: "RemoteMCPServer", name: binding.server },
                    tools: binding.tools,
                    requireApproval: binding.requireApproval,
                  },
                })),
              })
            }
          />
        </>
      )}
    </div>
  );
}
