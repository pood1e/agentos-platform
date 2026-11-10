import { useTranslation } from "react-i18next";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { ResourceReference } from "../../../gen/kagent/api/v1/common_pb.js";
import type { ModelConfig } from "../../../gen/kagent/api/v1/models_pb.js";
import { languageModels } from "../shared/runtime-models.js";

export function ModelConfigSelect({
  value: selectedModel,
  models,
  onChange,
  disabled = false,
}: {
  value?: ResourceReference;
  models: ModelConfig[];
  onChange: (value: ResourceReference | undefined) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const available = languageModels(models);
  const selected = selectedModel?.name ?? "";
  const value = available.some((model) => model.ref?.name === selected) ? selected : "";
  return (
    <div className="space-y-2">
      <Label>{t("management.modelConnection")}</Label>
      <Select
        value={value}
        disabled={disabled || available.length === 0}
        onValueChange={(name) => onChange(models.find((model) => model.ref?.name === name)?.ref)}
      >
        <SelectTrigger aria-label={t("management.modelConnection")}>
          <SelectValue placeholder={t("harness.selectModel")} />
        </SelectTrigger>
        <SelectContent>
          {available.map((model) => (
            <SelectItem key={model.ref?.name} value={model.ref?.name ?? ""}>
              {model.ref?.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {available.length === 0 && (
        <p className="text-xs text-destructive">{t("harness.noLanguageModel")}</p>
      )}
    </div>
  );
}
