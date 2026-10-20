import { useMutation, useQuery } from "@connectrpc/connect-query";
import { Check, LoaderCircle, Save } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import type { RoleDefinition } from "../../../gen/agentos/console/v1/role_pb.js";
import { ManagementService } from "../../../gen/agentos/management/v1/management_pb.js";
import type { AgentTemplate } from "../../../gen/kagent/api/v1alpha1/agent_templates_pb.js";
import type { Agent } from "../../../gen/kagent/api/v1alpha1/agents_pb.js";
import type { Harness } from "../../../gen/kagent/api/v1alpha1/harnesses_pb.js";
import type { ModelConfig } from "../../../gen/kagent/api/v1alpha1/models_pb.js";
import type { ToolServer } from "../../../gen/kagent/api/v1alpha1/tools_pb.js";
import { harnessToolsIssue } from "../../../shared/harness-model.js";
import { RoleModel } from "../engineers/RoleModel.js";
import { runtimeName } from "../shared/HarnessIcon.js";
import { object } from "./connection-schema.js";
import { HarnessPicker } from "./HarnessPicker.js";
import { Failure } from "./ResourcePage.js";
import { compatibleModels, runtimeModel } from "./runtime-models.js";

export function EngineerRuntime({
  agent,
  harnesses,
  models,
  servers,
  role,
  onApplied,
  active,
}: {
  agent: Agent;
  harnesses: Harness[];
  models: ModelConfig[];
  servers: ToolServer[];
  role: RoleDefinition;
  onApplied: (template?: AgentTemplate) => void;
  active: boolean;
}) {
  const { t } = useTranslation();
  const currentName = (agent: Agent) =>
    String(object(object(agent.resource?.value?.spec).harnessRef).name ?? "");
  const [selected, setSelected] = useState(() => currentName(agent));
  const [selectedModel, setSelectedModel] = useState(role.modelConfig?.name ?? "");
  const precondition = (agent: Agent) => ({
    generation: BigInt(String(object(agent.resource?.value?.metadata).generation ?? 0)),
    expectedUid: String(object(agent.resource?.value?.metadata).uid ?? ""),
  });
  const [version, setVersion] = useState(() => precondition(agent));
  const runtime = useQuery(
    ManagementService.method.getEngineerRuntime,
    { ref: agent.ref },
    { refetchInterval: 3_000, enabled: active },
  );
  const apply = useMutation(ManagementService.method.setEngineerRuntime);
  const current = runtime.data?.agent ?? agent;
  const chosen = harnesses.find((item) => item.ref?.name === selected);
  const model = models.find((item) => item.ref?.name === selectedModel);
  const compatible = !!model && compatibleModels(chosen, [model]).length === 1;
  const template =
    runtime.data?.agentTemplate?.resource?.value?.spec ??
    object(current.resource?.value?.spec).template;
  const changed =
    selected !== currentName(current) ||
    selectedModel !== String(object(object(template).modelConfig).name ?? "");
  const toolIssue =
    chosen && template && compatible
      ? harnessToolsIssue(chosen.runtime, object(template), current.ref?.namespace ?? "", servers)
      : undefined;
  const conditions = object(current.resource?.value?.status).conditions;
  const issue = Array.isArray(conditions)
    ? conditions.find((item) => object(item).status === "False" && object(item).message)
    : undefined;
  async function save() {
    try {
      const result = await apply.mutateAsync({
        ...version,
        engineer: current.ref,
        harness: chosen?.ref,
        modelConfig: model?.ref,
        templateResourceVersion: role.resourceVersion || undefined,
      });
      if (result.agent) setVersion(precondition(result.agent));
      await runtime.refetch();
      onApplied(result.agentTemplate);
    } catch {
      /* The mutation reports the localized error below. */
    }
  }
  return (
    <div className="space-y-5 p-4 sm:p-6" data-testid="engineer-runtime">
      <HarnessPicker
        harnesses={harnesses}
        value={selected}
        onChange={(name) => {
          setSelected(name);
          setSelectedModel(
            runtimeModel(
              harnesses.find((item) => item.ref?.name === name),
              models,
              selectedModel,
            ),
          );
          apply.reset();
        }}
        disabled={apply.isPending}
      />
      <RoleModel
        role={{ ...role, modelConfig: model?.ref }}
        models={models}
        harness={chosen}
        onChange={(next) => {
          setSelectedModel(next.modelConfig?.name ?? "");
          apply.reset();
        }}
        disabled={apply.isPending}
      />
      {chosen && (
        <dl className="space-y-3 text-sm">
          <div className="flex items-center justify-between gap-4">
            <dt className="text-muted-foreground">{t("harness.runtime")}</dt>
            <dd>{runtimeName(chosen.runtime)}</dd>
          </div>
          <div className="space-y-1">
            <dt className="text-muted-foreground">{t("harness.image")}</dt>
            <dd className="break-all font-mono text-xs">{chosen.workloadImage}</dd>
          </div>
        </dl>
      )}
      <p className="text-xs leading-5 text-muted-foreground">{t("harness.newSessions")}</p>
      {toolIssue && <p className="text-xs leading-5 text-destructive">{t(toolIssue)}</p>}
      {issue !== undefined && (
        <p className="text-xs leading-5 text-destructive">{String(object(issue).message)}</p>
      )}
      <Failure error={apply.error ?? runtime.error} />
      <Button
        onClick={() => void save()}
        disabled={
          apply.isPending || runtime.isPending || !chosen || !compatible || !!toolIssue || !changed
        }
        className="w-full"
      >
        {apply.isPending ? <LoaderCircle className="animate-spin" /> : <Save />}
        {t("harness.apply")}
      </Button>
      {apply.isSuccess && !changed && (
        <p className="flex items-center gap-2 text-xs text-success">
          <Check className="size-3.5" />
          {t("harness.applied")}
        </p>
      )}
    </div>
  );
}
