import { ModelPurpose } from "../../../gen/agentos/management/v1/management_pb.js";
import type { ModelConfig } from "../../../gen/kagent/api/v1/models_pb.js";
import { modelPurpose } from "../../../shared/model-purpose.js";

export const languageModels = (models: ModelConfig[]) =>
  models.filter((model) => modelPurpose(model.resource?.value) !== ModelPurpose.EMBEDDING);

export function runtimeModel(models: ModelConfig[], current: string) {
  const available = languageModels(models);
  return available.some((model) => model.ref?.name === current)
    ? current
    : available.length === 1
      ? (available[0].ref?.name ?? "")
      : "";
}
