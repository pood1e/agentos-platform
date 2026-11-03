import { create } from "@bufbuild/protobuf";
import type { Dispatch, SetStateAction } from "react";
import type { GetConfigurationResponse } from "../../../gen/agentos/console/v1/console_service_pb.js";
import type { RoleDefinition } from "../../../gen/agentos/console/v1/role_pb.js";
import type { Agent } from "../../../gen/kagent/api/v1/agents_pb.js";
import { ResourceReferenceSchema } from "../../../gen/kagent/api/v1/common_pb.js";
import { object } from "../../../shared/json.js";
import { HarnessPicker } from "../shared/HarnessPicker.js";
import { runtimeModel } from "../shared/runtime-models.js";
import { AgentRuntime } from "./AgentRuntime.js";
import { ModelConfigSelect } from "./ModelConfigSelect.js";
import { editRole } from "./role-draft.js";

export function RoleRuntime({
  agent,
  role,
  configuration,
  harness,
  onHarnessChange,
  onChange,
  onApplied,
  active,
}: {
  agent?: Agent;
  role: RoleDefinition;
  configuration: GetConfigurationResponse;
  harness: string;
  onHarnessChange: (name: string) => void;
  onChange: Dispatch<SetStateAction<RoleDefinition>>;
  onApplied: () => void;
  active: boolean;
}) {
  if (agent)
    return (
      <AgentRuntime
        agent={agent}
        defaultModel={role.modelConfig}
        models={configuration.modelConfigs}
        harnesses={configuration.harnesses}
        onApplied={(template) => {
          if (template?.resource?.value) {
            const value = template.resource.value;
            onChange((current) =>
              editRole(current, (next) => {
                next.resourceVersion = String(object(value.metadata).resourceVersion ?? "");
                next.modelConfig = create(ResourceReferenceSchema, {
                  name: String(object(object(value.spec).modelConfig).name ?? ""),
                  namespace: template.ref?.namespace ?? "",
                });
              }),
            );
          }
          onApplied();
        }}
        active={active}
      />
    );
  return (
    <div className="space-y-5 p-4 sm:p-6">
      <HarnessPicker
        harnesses={configuration.harnesses}
        value={harness}
        onChange={(name) => {
          onHarnessChange(name);
          onChange((current) =>
            editRole(current, (next) => {
              const modelName = runtimeModel(
                configuration.modelConfigs,
                current.modelConfig?.name ?? "default-model-config",
              );
              next.modelConfig = configuration.modelConfigs.find(
                (item) => item.ref?.name === modelName,
              )?.ref;
            }),
          );
        }}
      />
      <ModelConfigSelect
        value={role.modelConfig}
        models={configuration.modelConfigs}
        onChange={(model) =>
          onChange((current) =>
            editRole(current, (next) => {
              next.modelConfig = model;
            }),
          )
        }
      />
    </div>
  );
}
