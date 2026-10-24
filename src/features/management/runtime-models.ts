import { ModelPurpose } from "../../../gen/agentos/management/v1/management_pb.js";
import type { Harness } from "../../../gen/kagent/api/v1/harnesses_pb.js";
import type { ModelConfig } from "../../../gen/kagent/api/v1/models_pb.js";
import { harnessModelIssue } from "../../../shared/harness-model.js";
import { modelPurpose } from "../../../shared/model-purpose.js";
import { object } from "./connection-schema.js";

export const compatibleModels = (harness: Harness | undefined, models: ModelConfig[]) =>
  models.filter(
    (model) =>
      modelPurpose(model.resource?.value) !== ModelPurpose.EMBEDDING &&
      !harnessModelIssue(harness?.runtime ?? "", object(model.resource?.value?.spec)),
  );

export function runtimeModel(harness: Harness | undefined, models: ModelConfig[], current: string) {
  const available = compatibleModels(harness, models);
  return available.some((model) => model.ref?.name === current)
    ? current
    : available.length === 1
      ? (available[0].ref?.name ?? "")
      : "";
}
