import { useTranslation } from "react-i18next";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { RoleDefinition } from "../../../gen/agentos/console/v1/role_pb.js";
import type { Harness } from "../../../gen/kagent/api/v1/harnesses_pb.js";
import type { ModelConfig } from "../../../gen/kagent/api/v1/models_pb.js";
import { compatibleModels } from "../management/runtime-models.js";
import { editRole } from "./role-draft.js";

export function RoleModel({
  role,
  models,
  onChange,
  harness,
  disabled = false,
}: {
  role: RoleDefinition;
  models: ModelConfig[];
  onChange: (role: RoleDefinition) => void;
  harness?: Harness;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const available = compatibleModels(harness, models);
  const selected = role.modelConfig?.name ?? "";
  const value = available.some((model) => model.ref?.name === selected) ? selected : "";
  return (
    <div className="space-y-2">
      <Label>{t("management.modelConnection")}</Label>
      <Select
        value={value}
        disabled={disabled || available.length === 0}
        onValueChange={(name) =>
          onChange(
            editRole(role, (next) => {
              next.modelConfig = models.find((model) => model.ref?.name === name)?.ref;
            }),
          )
        }
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
        <p className="text-xs text-destructive">{t("harness.noCompatibleModel")}</p>
      )}
    </div>
  );
}
